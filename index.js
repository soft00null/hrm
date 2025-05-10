"use strict";



const express = require("express");
const admin = require("firebase-admin");
const fetchFn = require("node-fetch"); // node-fetch@2
const { Configuration, OpenAIApi } = require("openai");

// ----------------------------------------------------------------------
// Hard‑coded configuration values for Cloud Run deployment
const WHATSAPP_TOKEN = '';
const WHATSAPP_PHONE_ID = '';
const VERIFY_TOKEN = '';
const OPENAI_API_KEY = '';

// ----------------------------------------------------------------------
// 1) Firebase Admin
// ----------------------------------------------------------------------
if (!process.env.GOOGLE_CLOUD_PROJECT) {
  console.log("[INFO] Possibly local => loading serviceAccountKey.json...");
  try {
    const serviceAccount = require("./serviceAccountKey.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: "connectcare-hrm.firebasestorage.app" // confirm your bucket name
    });
    console.log("[INFO] Firebase Admin local init success.");
  } catch (err) {
    console.error("[ERROR] Could not load serviceAccountKey.json:", err);
    process.exit(1);
  }
} else {
  console.log("[INFO] Using default credentials for Firebase Admin...");
  admin.initializeApp({
    storageBucket: "connectcare-hrm.firebasestorage.app"
  });
}
const db = admin.firestore();
const bucket = admin.storage().bucket();
console.log("[INFO] Firestore + Storage ready.");

// ----------------------------------------------------------------------
// 2) OpenAI GPT-4o mini
// ----------------------------------------------------------------------
const openAiConfig = new Configuration({ apiKey: OPENAI_API_KEY });
const openai = new OpenAIApi(openAiConfig);
console.log("[INFO] OpenAI createChatCompletion configured.");

// ----------------------------------------------------------------------
// 3) Knowledge base from external link
// ----------------------------------------------------------------------
let knowledgeText = "No knowledgebase loaded.";
const knowledgeUrl =
  "https://Testhospital.in/";

(async function fetchKnowledgeBase() {
  try {
    console.log(`[INFO] Fetching knowledge from: ${knowledgeUrl}`);
    const resp = await fetchFn(knowledgeUrl);
    const text = await resp.text();
    knowledgeText = text;
    console.log(`[INFO] knowledge fetched => length=${knowledgeText.length}`);
  } catch (err) {
    console.error("[ERROR] Could not fetch knowledge =>", err);
    knowledgeText = "Error fetching knowledge data.";
  }
})();

// ----------------------------------------------------------------------
// Utility: random ID, random flow token
// ----------------------------------------------------------------------
function generateId(length = 8) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateFlowToken(length = 6) {
  const digits = "0123456789";
  let r = "";
  for (let i = 0; i < length; i++) {
    r += digits.charAt(Math.floor(Math.random() * digits.length));
  }
  return r;
}

// ----------------------------------------------------------------------
// Tools definition
// ----------------------------------------------------------------------
const openAiTools = [
  {
    name: "appointment_flow",
    description:
      "Handles new/reschedule/cancel appointment. 'new' => send interactive form => user fills => create doc in /Organisation/Test/Appointment",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "support_flow",
    description:
      "Send 'support' template => user fills => parse => create doc in /Organisation/Test/Ticket (support ticket).",
    parameters: {
      type: "object",
      properties: {
        department: { type: "string" },
      },
      required: ["department"],
    },
  },
  {
    name: "knowledge_lookup",
    description: `
Answers user questions about Test Multispeciality Hospital using only the loaded knowledgeBase text. 
This includes founders, hospital services, specialties, mission, vision, core values, insurance, TPAs, 
doctors & schedules, contact details, location, or any other info from knowledgeBase. 
1) Substring search to find relevant lines 
2) GPT fallback with those lines. 
No hallucination – only info from knowledgeBase should be used.
`,
    parameters: {
      type: "object",
      properties: {
        userQuery: { type: "string" },
      },
      required: ["userQuery"],
    },
  },
  {
    name: "small_talk",
    description: "Polite greeting or basic conversation when user just says hi/hello/etc.",
    parameters: {
      type: "object",
      properties: {
        userMessage: { type: "string" },
      },
      required: ["userMessage"],
    },
  },
  {
    name: "symptom_assessment",
    description: `
Triage user symptoms => disclaimers => suggests real doctors (from Firestore) for the user’s symptom. 
No made-up doctor names. GPT is used to classify the symptom into one known specialty, 
then you fetch matching doctors. 
`,
    parameters: {
      type: "object",
      properties: {
        userSymptom: { type: "string" },
      },
      required: ["userSymptom"],
    },
  }
];


// ----------------------------------------------------------------------
// Firestore references & creation
// ----------------------------------------------------------------------
async function getTestOrganisationRef() {
  const orgSnap = await db
    .collection("Organisation")
    .where("OrgID", "==", "Test")
    .limit(1)
    .get();
  if (orgSnap.empty) {
    console.log("[WARN] No Organisation doc => OrgID=Test");
    return null;
  }
  return orgSnap.docs[0].ref;
}

/**
 * Create or retrieve a PoC doc by phone.
 * If new, also add a "Patients" subcollection doc:
 *   - If PoC.Name == contactName => Relation = "Self", else "".
 */
async function getOrCreatePoCByPhone(phone, contactName) {
  console.log(`[INFO] getOrCreatePoCByPhone => phone=${phone}`);
  let snap = await db
    .collection("PoC")
    .where("Phone", "==", phone)
    .limit(1)
    .get();

  if (!snap.empty) {
    // Already exists
    console.log("[INFO] Found existing PoC => phone=", phone);
    return snap.docs[0].ref;
  }

  // Not found => create new PoC
  let safeName = contactName;
  let newDoc = await db.collection("PoC").add({
    Name: safeName,
    Phone: phone,
    BotMode: true,
    Created_Timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log("[INFO] Created new PoC =>", newDoc.id);

  // If PoC name == contact name => relation=Self, else blank
  let relationVal = "";
  if (safeName.trim().toLowerCase() === safeName.trim().toLowerCase()) {
    relationVal = "Self";
  }

  // Create the initial patient doc for the new PoC
  await newDoc.collection("Patients").add({
    Name: safeName,
    Gender: "NA",
    Age: 0,
    Relation: relationVal,
    DOB: admin.firestore.Timestamp.now(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return newDoc;
}

async function saveChatToPoC(pocRef, direction, from, to, msgType, msgBody, extraFields = {}) {
  let truncated = msgBody || "";
  if (truncated.length > 300) truncated = truncated.slice(0, 300) + "...(truncated)";

  let data = {
    Direction: direction,
    From: from,
    To: to,
    Msg_Type: msgType,
    Msg_Body: truncated,
    Timestamp: admin.firestore.FieldValue.serverTimestamp(),
    ...extraFields,
  };
  await pocRef.collection("Chat").add(data);
  console.log(
    `[INFO] Chat => direction=${direction}, from=${from}, to=${to}, msgType=${msgType}`
  );
}

// ----------------------------------------------------------------------
// Download from WA => upload to GCS => public link
// ----------------------------------------------------------------------
async function downloadWhatsAppMediaAndUpload(mediaId, mimeType = "application/octet-stream") {
  try {
    const token = WHATSAPP_TOKEN;
    let metaUrl = `https://graph.facebook.com/v17.0/${mediaId}`;
    let metaResp = await fetchFn(metaUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaResp.ok) {
      console.error("[ERROR] media meta resp =>", metaResp.status);
      return null;
    }
    let metaJson = await metaResp.json();
    if (!metaJson.url) {
      console.error("[ERROR] metaJson => missing .url =>", metaJson);
      return null;
    }

    let fileResp = await fetchFn(metaJson.url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!fileResp.ok) {
      console.error("[ERROR] fileResp =>", fileResp.status);
      return null;
    }
    let arrayBuf = await fileResp.arrayBuffer();
    let fileBuffer = Buffer.from(arrayBuf);

    let ext = "dat";
    if (mimeType.includes("image")) {
      ext = mimeType.split("/")[1];
    } else if (mimeType.includes("pdf")) {
      ext = "pdf";
    } else if (mimeType.includes("audio")) {
      ext = "audio";
    } else if (mimeType.includes("video")) {
      ext = "video";
    }
    let fileName = `${mediaId}.${ext}`;
    let fileRef = bucket.file(fileName);
    await fileRef.save(fileBuffer, { contentType: mimeType, resumable: false });
    await fileRef.makePublic();
    let publicUrl = `https://storage.googleapis.com/${fileRef.bucket.name}/${fileName}`;
    console.log("[INFO] media upload success =>", publicUrl);
    return publicUrl;
  } catch (err) {
    console.error("[ERROR] => downloadWhatsAppMediaAndUpload =>", err);
    return null;
  }
}

// ----------------------------------------------------------------------
// Appointment flow
// ----------------------------------------------------------------------
async function sendAppointmentFlow(userPhone) {
  console.log(`[INFO] sendAppointmentFlow => phone=${userPhone}`);
  const phoneId = WHATSAPP_PHONE_ID;
  const token = WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;

  const flowTok = generateFlowToken(6);

  let payload = {
    messaging_product: "whatsapp",
    to: userPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: "Test Hospital" },
      body: { text: "Please fill out this form to schedule your new appointment." },
      footer: { text: "ConnectCare HRM" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_action: "data_exchange",
          flow_token: flowTok,
          flow_id: "23951324727798005",
          flow_cta: "Book Appointment Now!",
        },
      },
    },
  };

  try {
    let resp = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    console.log(`[INFO] sendAppointmentFlow => status=${resp.status}`);
    let txt = await resp.text();
    console.log(`[INFO] sendAppointmentFlow => body=${txt}`);
  } catch (e) {
    console.error("[ERROR] => sendAppointmentFlow:", e);
  }
}

async function appointmentFlowImpl(action, userPhone) {
  console.log(`[INFO] appointmentFlowImpl => action=${action}, phone=${userPhone}`);
  switch (action) {
    case "new":
      await sendAppointmentFlow(userPhone);
      return "Appointment form sent.";
    case "reschedule":
      return "Rescheduling placeholder. Not implemented.";
    case "cancel":
      return "Cancellation placeholder. Not implemented.";
    default:
      return "Unknown appointment action => new, reschedule, cancel only.";
  }
}

async function createAppointmentDoc(pocRef, userPhone, flowData) {
  console.log(`[INFO] createAppointmentDoc => userPhone=${userPhone}`);
  let { flow_token, doctorId, date, time, reason, name, age, gender, specialty } = flowData || {};
  let patientName = name;

  // parse date => timestamp
  let dateTs = null;
  if (date) {
    let d = new Date(date);
    if (!isNaN(d.getTime())) {
      dateTs = admin.firestore.Timestamp.fromDate(d);
    }
  }

  const orgRef = await getTestOrganisationRef();
  if (!orgRef) {
    console.log("[WARN] no Org doc => cannot create appointment");
    return;
  }

  let doctorRef = db.collection("Doctors").doc(doctorId);
  let drSnap = await doctorRef.get();
  let drData = drSnap.exists ? drSnap.data() : {};
  let doctorName = drData.Name;

  let aptId = "APT-" + generateId(8);
  let aptDoc = {
    AppointmentID: aptId,
    PoCRef: pocRef,
    DoctorRef: doctorRef,
    userPhone,
    doctorId: doctorId || "",
    doctorName,
    specialty: specialty || "",
    timeSlot: time || "",
    patientName,
    patientAge: age || "",
    patientGender: gender || "",
    reason: reason || "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "Draft",
    date: date || "",
    dateTimestamp: dateTs || null,
    FlowToken: flow_token || "",
  };

  let aptRef = orgRef.collection("Appointment").doc(aptId);
  await aptRef.set(aptDoc);
  console.log(`[INFO] Appointment => /Organisation/Test/Appointment/${aptId} created.`);

  // Check if patient with same name already exists
  let existingSnap = await pocRef
    .collection("Patients")
    .where("Name", "==", patientName)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    console.log(
      `[INFO] Patient with name="${patientName}" already exists => not adding new doc`
    );
    return;
  }

  // Else => create new patient doc
  let pocSnap = await pocRef.get();
  let pocData = pocSnap.data() || {};
  let isSelf = false;
  if (
    pocData.Name &&
    pocData.Name.trim().toLowerCase() === patientName.trim().toLowerCase()
  ) {
    isSelf = true;
  }
  let newRelation = isSelf ? "Self" : "";

  await pocRef.collection("Patients").add({
    Name: patientName,
    Age: parseInt(age, 10),
    DOB: admin.firestore.Timestamp.now(),
    Gender: gender,
    Relation: newRelation,
    reason: reason || "",
    appointmentId: aptId,
    specialty: specialty || "",
    date: date || "",
    time: time || "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(
    `[INFO] New Patient doc added to PoC/${pocRef.id}/Patients => name="${patientName}"`
  );
}

// ----------------------------------------------------------------------
// Support flow
// ----------------------------------------------------------------------
async function sendSupportTemplate(userPhone) {
  console.log(`[INFO] sendSupportTemplate => phone=${userPhone}`);
  const phoneId = WHATSAPP_PHONE_ID;
  const token = WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

  let payload = {
    messaging_product: "whatsapp",
    to: userPhone,
    type: "template",
    template: {
      name: "support",
      language: {
        code: "en",
        policy: "deterministic",
      },
      components: [
        {
          type: "body",
          parameters: [
            {
              type: "text",
              text: "Test Hospital",
            },
          ],
        },
        {
          type: "button",
          sub_type: "FLOW",
          index: 0,
          parameters: [],
        },
      ],
    },
  };

  try {
    let resp = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    console.log(`[INFO] sendSupportTemplate => status=${resp.status}`);
    let txt = await resp.text();
    console.log(`[INFO] sendSupportTemplate => body=${txt}`);
  } catch (e) {
    console.error("[ERROR] => sendSupportTemplate:", e);
  }
}

async function supportFlowImpl(department, userPhone) {
  console.log(`[INFO] supportFlowImpl => dept=${department}, userPhone=${userPhone}`);
  await sendSupportTemplate(userPhone);
  return "Support form sent.";
}

async function createSupportTicket(pocRef, userId, flowData) {
  console.log(`[INFO] createSupportTicket => userId=${userId}, flowData=`, flowData);

  const orgRef = await getTestOrganisationRef();
  if (!orgRef) {
    console.log("[WARN] no Org doc => cannot create ticket");
    return;
  }

  let description = flowData["screen_0_Description_of_issue_2"];
  let urgencyVal = flowData["screen_0_Urgency_1"];
  let categoryVal = flowData["screen_0_Category_0"];

  let urgency = parseNumberFromLabel(urgencyVal, "Low");
  let category = parseNumberFromLabel(categoryVal, "General");

  let ticketId = "TIC-" + generateId(8);
  let doc = {
    TicketID: ticketId,
    PoCRef: pocRef,
    description,
    urgency,
    category,
    status: "open",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  let ticketRef = orgRef.collection("Ticket").doc(ticketId);
  await ticketRef.set(doc);
  console.log(`[INFO] Created Ticket => /Organisation/Test/Ticket/${ticketId}`);
}

// ----------------------------------------------------------------------
// Checkin flow
// ----------------------------------------------------------------------
async function createCheckinDoc(pocRef, userPhone) {
  console.log(`[INFO] createCheckinDoc => phone=${userPhone}`);
  const orgRef = await getTestOrganisationRef();
  if (!orgRef) {
    console.log("[WARN] no Org doc => cannot create checkin");
    return;
  }
  let checkinId = "CHK-" + generateId(8);
  let doc = {
    CheckinID: checkinId,
    PoCRef: pocRef,
    phone: userPhone,
    checkinTime: admin.firestore.FieldValue.serverTimestamp(),
  };
  let checkinRef = orgRef.collection("Checkin").doc(checkinId);
  await checkinRef.set(doc);
  console.log(`[INFO] Created Checkin => /Organisation/Test/Checkin/${checkinId}`);
}

// ----------------------------------------------------------------------
// Additional GPT usage for knowledge base fallback
// ----------------------------------------------------------------------

/** 
 * Summarize or interpret the entire knowledge text with the user query. 
 * If GPT says there's relevant info, return it. Otherwise, return empty.
 */
async function checkKnowledgeFullWithGpt(userQuery, fullKnowledgeText) {
  try {
    const content = `
You are Test Hospital's helpful assistant. 
The user asked: "${userQuery}"
Below is the ENTIRE knowledge base text:

${fullKnowledgeText}

Try to find any relevant info. 
If you find something relevant, summarize it or respond in a friendly tone. 
If there's truly nothing relevant, respond with an empty line or say "No relevant info."
`;
    let completion = await openai.createChatCompletion({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful, human-like hospital knowledge assistant." },
        { role: "user", content }
      ],
      temperature: 0.5
    });
    let reply = completion.data.choices?.[0]?.message?.content?.trim() || "";
    // If GPT basically says no relevant info, we interpret that as empty
    if (
      reply.toLowerCase().includes("no relevant info") ||
      reply.toLowerCase().includes("no relevant information") ||
      reply.toLowerCase().includes("nothing relevant") ||
      reply.length < 4
    ) {
      return "";
    }
    return reply;
  } catch (err) {
    console.error("[ERROR] checkKnowledgeFullWithGpt =>", err);
    return "";
  }
}

// ----------------------------------------------------------------------
// knowledgeLookupImpl => substring search => if no lines => GPT fallback
// ----------------------------------------------------------------------
async function knowledgeLookupImpl(userQuery) {
  console.log(`[INFO] knowledgeLookupImpl => q="${userQuery}"`);
  if (!knowledgeText || knowledgeText.startsWith("Error fetching")) {
    return "No knowledgebase loaded. Sorry.";
  }

  // 1) Lowercase the user query
  const lcQuery = userQuery.toLowerCase();

  // 2) Split knowledgeText by lines
  const lines = knowledgeText.split("\n");

  // 3) Filter lines that contain the user query
  const matchingLines = lines.filter((line) => line.toLowerCase().includes(lcQuery));

  // 4) If we found something, we can either return them directly
  //    Or feed them to GPT for a refined summary
  if (matchingLines.length > 0) {
    // Summarize them via GPT for a more natural reply
    return await refineKnowledgeWithGpt(userQuery, matchingLines);
  }

  // 5) If zero lines => do a GPT pass over the entire knowledge base text
  let fallbackReply = await checkKnowledgeFullWithGpt(userQuery, knowledgeText);
  if (fallbackReply && fallbackReply.trim().length > 0) {
    return fallbackReply; // use GPT's final answer
  }

  // 6) If GPT also found nothing
  return "No direct info found in the knowledge base. Please ask more about Test hospital!";
}

/**
 * Summarize the matched lines into a natural reply.
 */
async function refineKnowledgeWithGpt(userQuery, matchedLines) {
  try {
    const content = `
You are Test Hospital's helpful assistant. 
The user asked: "${userQuery}"
We found these lines in the local knowledge database:

${matchedLines.join("\n")}

Please summarize them or craft a short, natural response. 
If the lines mention specific details, share them in a friendly tone.
`;
    let completion = await openai.createChatCompletion({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful, human-like hospital knowledge assistant." },
        { role: "user", content }
      ]
    });
    let choice = completion.data.choices[0];
    if (!choice) return matchedLines.join("\n");
    return choice.message.content || matchedLines.join("\n");
  } catch (err) {
    console.error("[ERROR] refineKnowledgeWithGpt =>", err);
    // fallback => just return matched lines
    return matchedLines.join("\n");
  }
}

// ----------------------------------------------------------------------
// small talk
// ----------------------------------------------------------------------
function smallTalkImpl(userMessage) {
  console.log(`[INFO] smallTalkImpl => userMessage="${userMessage}"`);
  // Just keep it short and sweet.
  return `Hello! Test Hospital is here to help. How can we assist you today?`;
}

// ----------------------------------------------------------------------
// GPT-based Symptom Classification + Triage
// ----------------------------------------------------------------------
async function symptomAssessmentImpl(userSymptom) {
  console.log("[INFO] symptomAssessment => userSymptom=", userSymptom);

  let lines = userSymptom
    .split(/(\.|,|\n)/)
    .map((s) => s.trim())
    .filter((x) => x && x.length > 2);

  let resultParts = [];
  for (let line of lines) {
    // 1) Let GPT pick the best specialty from the fixed list
    let gptSpecialty = await classifySymptomWithGpt(line);
    // 2) Then run our fuzzy matching in Doctors collection
    let docList = await findDoctorsByFuzzySpecialty(gptSpecialty);

    // Create a user-friendly message
    let partialMsg = `**Symptom**: "${line}"\nLikely specialty: ${gptSpecialty}.\nDisclaimer: This is basic guidance, not a formal diagnosis. Please consult in person for serious concerns.`;
    if (docList && docList.length > 0) {
      partialMsg += `\n**Possible doctors** matching that specialty:`;
      for (let d of docList) {
        partialMsg += `\n**${d.Name}** (Specialization: ${d.Specialization.join(", ")})`;
      }
    } else {
      partialMsg += `\n[No specific doctor found in for specialty "${gptSpecialty}" - kindly see a general physician.]`;
    }

    resultParts.push(partialMsg);
  }

  let finalCombined = resultParts.join("\n\n");
  finalCombined += `

Would you like to book an appointment with any of these doctors or ask more questions? 
If it feels severe, please see a physician immediately.`;

  return finalCombined;
}

/**
 * We have a fixed list of possible specialties:
 *   [General Physician, Neurologist, Cardiologist, Orthopedic Surgeon, 
 *    Pediatrician, Gynecologist, Pathologist, Oncologist, 
 *    ENT Surgeon, Gastroenterologist, Neuro Physician, 
 *    General Surgeon, Urologist, Nephrologist, Dermatologist, Psychologist].
 * 
 * We call GPT to classify the symptom line into exactly one from that list.
 * If it fails or is uncertain, fallback to "General Physician".
 */
async function classifySymptomWithGpt(symptomLine) {
  const POSSIBLE_SPECIALTIES = [
    "General Physician",
    "Neurologist",
    "Cardiologist",
    "Orthopedic Surgeon",
    "Pediatrician",
    "Gynecologist",
    "Pathologist",
    "Oncologist",
    "ENT Surgeon",
    "Gastroenterologist",
    "Neuro Physician",
    "General Surgeon",
    "Urologist",
    "Nephrologist",
    "Dermatologist",
    "Physiotherapist",
    "RMO",
    "Psychologist"
  ];
  try {
    const prompt = `
You are a medical triage assistant. 
Given the user symptom: "${symptomLine}"

Pick exactly ONE specialty from this list that best addresses that symptom:
${POSSIBLE_SPECIALTIES.join(", ")}

If multiple might apply, pick the one that is most likely/primary. 
If uncertain, pick "General Physician".
Return exactly the name with no extra text. 
`;
    let completion = await openai.createChatCompletion({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a helpful, human-like medical triage assistant." },
        { role: "user", content: prompt }
      ],
      temperature: 0.0
    });
    let specialty = completion.data.choices?.[0]?.message?.content?.trim() || "";
    // validate
    if (!POSSIBLE_SPECIALTIES.some(s => s.toLowerCase() === specialty.toLowerCase())) {
      specialty = "General Physician";
    }
    console.log(`[INFO] GPT classified symptom => "${symptomLine}" => ${specialty}`);
    return specialty;
  } catch (err) {
    console.error("[ERROR] classifySymptomWithGpt =>", err);
    return "General Physician";
  }
}

// ----------------------------------------------------------------------
// Naive fuzzy matching with doc's .Specialization
// ----------------------------------------------------------------------
async function findDoctorsByFuzzySpecialty(specialty) {
  try {
    let snap = await db.collection("Doctors").where("OrgID", "==", "Test").get();
    if (snap.empty) {
      console.log("[INFO] no doctors at all");
      return [];
    }
    let matchedDocs = [];
    // remove quotes/spaces from the target
    let target = specialty.toLowerCase().trim().replace(/^['"]|['"]$/g, "");

    for (let doc of snap.docs) {
      let data = doc.data();
      let arr = data.Specialization || [];
      if (!Array.isArray(arr)) continue;

      let foundMatch = arr.some((spec) => {
        // strip quotes + trim
        let s = spec.toLowerCase().trim().replace(/^['"]|['"]$/g, "");
        let dist = levenshteinDistance(s, target);
        let substringCheck = s.includes(target) || target.includes(s);
        return (dist <= 3 || substringCheck);
      });
      if (foundMatch) {
        matchedDocs.push(data);
      }
    }
    return matchedDocs;
  } catch (err) {
    console.error("[ERROR] findDoctorsByFuzzySpecialty =>", err);
    return [];
  }
}

function levenshteinDistance(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  let matrix = [];
  let ia = a.length, ib = b.length;

  for (let i = 0; i <= ia; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= ib; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= ia; i++) {
    for (let j = 1; j <= ib; j++) {
      if (a.charAt(i - 1) === b.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + 1
        );
      }
    }
  }
  return matrix[ia][ib];
}

// ----------------------------------------------------------------------
// parseYesNo, parseStarRating, parseNumberFromLabel
// ----------------------------------------------------------------------
function parseYesNo(val, fallback = "No") {
  if (!val) return fallback;
  let parts = val.split("_");
  if (parts.length > 1) return parts[1];
  return val;
}

function parseStarRating(val, fallback = "NA") {
  if (!val) return fallback;
  let match = val.match(/\((\d)\/5\)/);
  if (match && match[1]) return match[1];
  return fallback;
}

function parseNumberFromLabel(val, fallback = "Unknown") {
  if (!val) return fallback;
  let parts = val.split("_");
  if (parts.length > 1) return parts[1];
  return val;
}

// ----------------------------------------------------------------------
// 12) updateAppointmentFeedback => parse => find apt => store
// ----------------------------------------------------------------------
async function updateAppointmentFeedback(flowData) {
  console.log("[INFO] updateAppointmentFeedback => flowData=", flowData);
  let flowToken = flowData["flow_token"] || "";
  let rawRecommend = flowData["screen_0_Choose_0"];
  let rawComments = flowData["screen_0_Leave_a_1"] || "";
  let rawStaff = flowData["screen_1_Staff_Experience_0"];
  let rawDoc = flowData["screen_1_Doctor_consultation_1"];
  let rawOverall = flowData["screen_1_Overall_Experience_2"];

  let recommend = parseYesNo(rawRecommend, "No");
  let comments = rawComments;
  let staffExp = parseStarRating(rawStaff, "NA");
  let docConsult = parseStarRating(rawDoc, "NA");
  let overallExp = parseStarRating(rawOverall, "NA");

  console.log(
    `[INFO] final => recommend=${recommend}, staffExp=${staffExp}, docConsult=${docConsult}, overallExp=${overallExp}`
  );

  const orgRef = await getTestOrganisationRef();
  if (!orgRef) {
    console.log("[WARN] no Org doc => can't store feedback");
    return;
  }
  let aptSnap = await orgRef
    .collection("Appointment")
    .where("FlowToken", "==", flowToken)
    .limit(1)
    .get();
  if (aptSnap.empty) {
    console.log("[WARN] no appointment doc with FlowToken=", flowToken);
    return;
  }
  let aptRef = aptSnap.docs[0].ref;

  let feedback = {
    Recommend: recommend,
    Comments: comments,
    Staff_Experience: staffExp,
    Doctor_consultation: docConsult,
    Overall_Experience: overallExp,
    submittedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await aptRef.update({ feedback });
  console.log(`[INFO] feedback updated => doc=${aptRef.id}`);
}

// ----------------------------------------------------------------------
// 8) handleLocalFunctionCall
// ----------------------------------------------------------------------
async function handleLocalFunctionCall(name, args, fromPhone, userId, userQuery) {
  console.log(`[INFO] handleLocalFunctionCall => name=${name}`);
  switch (name) {
    case "appointment_flow":
      return appointmentFlowImpl(args.action, fromPhone);

    case "support_flow":
      return supportFlowImpl(args.department, fromPhone);

    case "knowledge_lookup":
      // now an async function => we must await
      return await knowledgeLookupImpl(args.userQuery || "");

    case "small_talk":
      return smallTalkImpl(args.userMessage || "");

    case "symptom_assessment":
      // now an async function => must await
      return await symptomAssessmentImpl(args.userSymptom || "");

    default:
      return "Kindly only ask anything related to Test Hospital.";
  }
}

async function handleOpenAiFunctionCall(fCall, fromPhone, userId, userQuery) {
  console.log(`[INFO] handleOpenAiFunctionCall => functionName="${fCall.name}"`);
  try {
    let parsed = JSON.parse(fCall.arguments);
    return await handleLocalFunctionCall(fCall.name, parsed, fromPhone, userId, userQuery);
  } catch (e) {
    console.error("[ERROR] handleOpenAiFunctionCall => parse error:", e);
    return "Error parsing function arguments.";
  }
}

// ----------------------------------------------------------------------
// 9) sendWhatsAppMessage
// ----------------------------------------------------------------------
async function sendWhatsAppMessage(to, message) {
  console.log(`[INFO] sendWhatsAppMessage => to=${to}, msg="${message}"`);
  const token = WHATSAPP_TOKEN;
  const phoneId = WHATSAPP_PHONE_ID;
  const url = `https://graph.facebook.com/v17.0/${phoneId}/messages`;

  let payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: message },
  };
  try {
    let resp = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    console.log(`[INFO] sendWhatsAppMessage => status=${resp.status}`);
    let txt = await resp.text();
    console.log(`[INFO] sendWhatsAppMessage => body=${txt}`);
  } catch (e) {
    console.error("[ERROR] => sendWhatsAppMessage:", e);
  }
}

// ----------------------------------------------------------------------
// 10) System Prompt
// ----------------------------------------------------------------------
const systemMessage = {
  role: "system",
  content: `
You are Test Hospital's Chatbot in English. 
We've replaced the old knowledge lookup with substring search + 
a fallback GPT pass over the entire knowledge base if no substring found. 
We also use GPT for symptom classification. 
No other flows changed. 
Respond in a natural, friendly, and helpful manner.
`,
};

// ----------------------------------------------------------------------
// 11) Express + Webhook
// ----------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/webhook", (req, res) => {
  const verifyToken = VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  console.log(`[INFO] GET /webhook => mode=${mode}, token=${token}`);
  if (mode && token) {
    if (mode === "subscribe" && token === verifyToken) {
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});

app.post("/webhook", async (req, res) => {
  try {
    console.log("[INFO] POST /webhook => incoming");
    if (!req.body.object) return res.sendStatus(404);

    const entry = (req.body.entry && req.body.entry[0]) || {};
    const changes = (entry.changes && entry.changes[0]) || {};
    const value = changes.value || {};
    const msg = (value.messages && value.messages[0]) || null;

    // attempt userName from contacts
    const contactName =
      (value.contacts &&
        value.contacts[0] &&
        value.contacts[0].profile &&
        value.contacts[0].profile.name) ||
      "Unknown";

    // A) nfm_reply => either support, appointment, or feedback flow
    if (msg && msg.interactive && msg.interactive.type === "nfm_reply") {
      console.log(
        "[INFO] nfm_reply => parse => either support, appointment, or feedback doc"
      );
      const fromUser = msg.from;
      let rawJson = msg.interactive.nfm_reply.response_json;
      let flowData = JSON.parse(rawJson);

      const pocRef = await getOrCreatePoCByPhone(fromUser, contactName);
      let shortFlow = JSON.stringify(flowData);
      if (shortFlow.length > 300) shortFlow = shortFlow.slice(0, 300) + "...(truncated)";

      // check if it's feedback => "screen_0_Choose_0"
      if (flowData["screen_0_Choose_0"]) {
        // => feedback
        await saveChatToPoC(
          pocRef,
          "inbound",
          fromUser,
          WHATSAPP_PHONE_ID,
          "interactive",
          shortFlow
        );
        await updateAppointmentFeedback(flowData);
        let finalMsg = "Thank you for your feedback!";
        await sendWhatsAppMessage(fromUser, finalMsg);
        await saveChatToPoC(
          pocRef,
          "outbound",
          WHATSAPP_PHONE_ID,
          fromUser,
          "text",
          finalMsg
        );
      }
      // else if it has screen_0_Description_of_issue_2 => support
      else if (flowData["screen_0_Description_of_issue_2"]) {
        await saveChatToPoC(
          pocRef,
          "inbound",
          fromUser,
          WHATSAPP_PHONE_ID,
          "interactive",
          shortFlow
        );
        await createSupportTicket(pocRef, pocRef.id, flowData);
        let finalMsg = "We have created your support ticket. Thank you!";
        await sendWhatsAppMessage(fromUser, finalMsg);
        await saveChatToPoC(
          pocRef,
          "outbound",
          WHATSAPP_PHONE_ID,
          fromUser,
          "text",
          finalMsg
        );
      } else {
        // assume appointment
        await saveChatToPoC(
          pocRef,
          "inbound",
          fromUser,
          WHATSAPP_PHONE_ID,
          "interactive",
          shortFlow
        );
        await createAppointmentDoc(pocRef, fromUser, flowData);
        let ack = "Your appointment has been recorded. Thank you!";
        await sendWhatsAppMessage(fromUser, ack);
        await saveChatToPoC(
          pocRef,
          "outbound",
          WHATSAPP_PHONE_ID,
          fromUser,
          "text",
          ack
        );
      }
      return res.sendStatus(200);
    }

    // B) Media or normal text
    if (msg) {
      const from = msg.from;
      const pocRef = await getOrCreatePoCByPhone(from, contactName);

      if (["image", "video", "audio", "document"].includes(msg.type)) {
        // handle media
        console.log(`[INFO] user ${from} sends media => type=${msg.type}`);
        let mediaId, mimeType;
        if (msg.type === "image") {
          mediaId = msg.image.id;
          mimeType = msg.image.mime_type;
        } else if (msg.type === "video") {
          mediaId = msg.video.id;
          mimeType = msg.video.mime_type;
        } else if (msg.type === "audio") {
          mediaId = msg.audio.id;
          mimeType = msg.audio.mime_type;
        } else if (msg.type === "document") {
          mediaId = msg.document.id;
          mimeType = msg.document.mime_type;
        }

        let publicUrl = await downloadWhatsAppMediaAndUpload(mediaId, mimeType);
        if (!publicUrl) {
          publicUrl = "Failed to retrieve media from WA.";
        }

        // store chat with public link
        if (msg.type === "image") {
          await saveChatToPoC(
            pocRef,
            "inbound",
            from,
            WHATSAPP_PHONE_ID,
            "image",
            "User sent an image",
            { Msg_Image: publicUrl }
          );
        } else if (msg.type === "document") {
          let extension = mimeType.includes("pdf") ? "pdf" : "doc";
          await saveChatToPoC(
            pocRef,
            "inbound",
            from,
            WHATSAPP_PHONE_ID,
            extension,
            publicUrl
          );
        } else if (msg.type === "video") {
          await saveChatToPoC(
            pocRef,
            "inbound",
            from,
            WHATSAPP_PHONE_ID,
            "video",
            publicUrl
          );
        } else if (msg.type === "audio") {
          await saveChatToPoC(
            pocRef,
            "inbound",
            from,
            WHATSAPP_PHONE_ID,
            "audio",
            publicUrl
          );
        }

        return res.sendStatus(200);
      } else if (msg.type === "text") {
        const userText = msg.text.body || "";
        console.log(`[INFO] user(${from}) => text="${userText}"`);
        await saveChatToPoC(pocRef, "inbound", from, WHATSAPP_PHONE_ID, "text", userText);

        // "Checkin:Test" => create doc
        if (userText.startsWith("Checkin:")) {
          let checkVal = userText.split(":")[1] || "";
          if (checkVal.trim() === "Test") {
            await createCheckinDoc(pocRef, from);
            let checkAck = "Welcome to Test! Check-in recorded. Please proceed!";
            await sendWhatsAppMessage(from, checkAck);
            await saveChatToPoC(
              pocRef,
              "outbound",
              WHATSAPP_PHONE_ID,
              from,
              "text",
              checkAck
            );
            return res.sendStatus(200);
          }
        }

        // else BotMode => AI
        let docSnap = await pocRef.get();
        let pocData = docSnap.data() || {};
        let botMode = pocData.BotMode !== false;
        if (!botMode) {
          console.log("[INFO] BotMode=false => store chat only, no AI");
          return res.sendStatus(200);
        }

        let chatState = pocData.chatState || { messages: [] };
        let messages = chatState.messages || [];
        if (!messages.find((m) => m.role === "system")) {
          messages.unshift(systemMessage);
        }
        messages.push({ role: "user", content: userText });

        console.log("[INFO] calling openai => function_call=auto");
        let completion = await openai.createChatCompletion({
          model: "gpt-4o-mini",
          messages,
          functions: openAiTools,
          function_call: "auto",
        });
        let choice = (completion.data.choices && completion.data.choices[0]) || null;
        if (!choice) return res.sendStatus(200);

        let reply = "";
        if (choice.message && choice.message.function_call) {
          let fc = choice.message.function_call;
          console.log(`[INFO] AI calls function => ${fc.name}`);
          reply = await handleOpenAiFunctionCall(fc, from, pocRef.id, userText);
          messages.push({ role: "assistant", content: reply });
        } else {
          // fallback normal text
          reply = (choice.message && choice.message.content);
          messages.push({ role: "assistant", content: reply });
        }

        await pocRef.set({ chatState: { messages } }, { merge: true });

        // parse if JSON => .reply
        let finalReply = reply;
        try {
          let p = JSON.parse(reply);
          if (p && p.reply) finalReply = p.reply;
        } catch (e) {
          // not JSON
        }

        await sendWhatsAppMessage(from, finalReply);
        await saveChatToPoC(
          pocRef,
          "outbound",
          WHATSAPP_PHONE_ID,
          from,
          "text",
          finalReply
        );

        return res.sendStatus(200);
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("[ERROR] =>", e);
    return res.status(500).json({ error: e.message });
  }
});


// Export Express app as Cloud Function entry point

// Cloud Functions entry point registration using @google-cloud/functions-framework
const functions = require('@google-cloud/functions-framework');

// Register the Express app as an HTTP Cloud Function called "webhook"
functions.http('Test', app);
