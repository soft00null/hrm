"use strict";

const express = require("express");
const admin = require("firebase-admin");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)); // ESM import for Node.js 22
const { Configuration, OpenAIApi } = require("openai");
const fs = require('fs/promises');
const path = require('path');
const functions = require('@google-cloud/functions-framework');

// ----------------------------------------------------------------------
// Hard‑coded configuration values for Cloud Run deployment
const WHATSAPP_TOKEN = '';
const WHATSAPP_PHONE_ID = '';
const VERIFY_TOKEN = '';
const OPENAI_API_KEY = '';

// ----------------------------------------------------------------------
// 1) Firebase Admin Initialization for Cloud or Local Environment
// ----------------------------------------------------------------------
if (!process.env.GOOGLE_CLOUD_PROJECT) {
  console.log("[INFO] Possibly local => loading serviceAccountKey.json...");
  try {
    const serviceAccount = require("./serviceAccountKey.json");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: "connectcare-hrm.firebasestorage.app"
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
// 3) Knowledge base from local file
// ----------------------------------------------------------------------
let knowledgeText = "No knowledgebase loaded.";
const knowledgebasePath = path.join(__dirname, 'knowledgebase.txt');

(async function loadKnowledgeBase() {
  try {
    console.log(`[INFO] Loading knowledge from local file: ${knowledgebasePath}`);
    knowledgeText = await fs.readFile(knowledgebasePath, 'utf8');
    console.log(`[INFO] Knowledge loaded => length=${knowledgeText.length}`);
  } catch (err) {
    console.error("[ERROR] Could not load knowledge file =>", err);
    knowledgeText = "Error loading knowledge data from local file.";
  }
})();

// ----------------------------------------------------------------------
// Utility: Get Current Indian Time (IST = UTC+5:30)
// ----------------------------------------------------------------------
function getCurrentIndianTime() {
  // Create timestamp with current server time
  return admin.firestore.Timestamp.now();
}

// Format IST timestamp for logging (YYYY-MM-DD HH:MM:SS format)
function formatISTTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Update the lastSeen field of a PoC with current IST
 */
async function updatePoCLastSeen(pocRef) {
  if (!pocRef) return;
  try {
    await pocRef.update({
      lastSeen: getCurrentIndianTime()
    });
    console.log(`[INFO] Updated lastSeen for PoC: ${pocRef.id} at ${formatISTTimestamp()}`);
  } catch (err) {
    console.error(`[ERROR] Failed to update lastSeen: ${err}`);
  }
}

// ----------------------------------------------------------------------
// Utility: Get Organization ID from Request Context
// ----------------------------------------------------------------------
async function getOrganizationFromContext(req) {
  // Option 1: Get from request headers
  const orgIdFromHeader = req.headers['x-organization-id'];
  if (orgIdFromHeader) {
    console.log(`[INFO] Using organization ID from header: ${orgIdFromHeader}`);
    return orgIdFromHeader;
  }
  
  // Option 2: Get from request path/parameters
  const orgIdFromParams = req.query.orgId || req.params.orgId;
  if (orgIdFromParams) {
    console.log(`[INFO] Using organization ID from parameters: ${orgIdFromParams}`);
    return orgIdFromParams;
  }
  
  // Option 3: Get from message content (for WhatsApp webhook)
  const entry = (req.body.entry && req.body.entry[0]) || {};
  const changes = (entry.changes && entry.changes[0]) || {};
  const value = changes.value || {};
  const msg = (value.messages && value.messages[0]) || null;
  
  if (msg && msg.context && msg.context.organization_id) {
    const orgId = msg.context.organization_id;
    console.log(`[INFO] Using organization ID from message context: ${orgId}`);
    return orgId;
  }
  
  // Option 4: Try to get from metadata or custom attributes
  if (value && value.metadata && value.metadata.organization_id) {
    const orgId = value.metadata.organization_id;
    console.log(`[INFO] Using organization ID from metadata: ${orgId}`);
    return orgId;
  }
  
  // Default fallback - perhaps from environment or configuration
  console.log(`[INFO] Using default organization ID: Test`);
  return "Test";
}

// ----------------------------------------------------------------------
// Find PoCs across organizations (for cross-org features)
// ----------------------------------------------------------------------
async function findPoCsAcrossOrganizations(phone) {
  try {
    const snap = await db
      .collection("PoC")
      .where("Phone", "==", phone)
      .get();
    
    const results = snap.docs.map(doc => ({
      id: doc.id,
      organization: doc.data().addedBy || "Unknown",
      lastSeen: doc.data().lastSeen ? doc.data().lastSeen.toDate().toISOString() : null,
      registered: doc.data().registered === true ? "Yes" : "No",
      ...doc.data()
    }));
    
    console.log(`[INFO] Found ${results.length} PoCs across organizations for phone ${phone} at ${formatISTTimestamp()}`);
    return results;
  } catch (err) {
    console.error("[ERROR] findPoCsAcrossOrganizations =>", err);
    return [];
  }
}

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
Triage user symptoms => disclaimers => suggests real doctors (from Firestore) for the user's symptom. 
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
async function getOrganisationRef(orgId) {
  const orgSnap = await db
    .collection("Organisation")
    .where("OrgID", "==", orgId)
    .limit(1)
    .get();
  if (orgSnap.empty) {
    console.log(`[WARN] No Organisation doc => OrgID=${orgId}`);
    return null;
  }
  return orgSnap.docs[0].ref;
}

async function getTestOrganisationRef() {
  return getOrganisationRef("Test");
}

/**
 * Create a notification in the Organisation's Notifications subcollection with extended fields
 * @param {Object} orgRef - Reference to the organisation document
 * @param {String} from - Phone number of the PoC
 * @param {String} message - Notification message content
 * @param {String} event - Type of event (Appointment, Ticket, Feedback, Message, EventCounts)
 * @param {Object} references - Additional document references (pocRef, appointmentRef, ticketRef, etc.)
 * @returns {Promise<DocumentReference>} - Reference to the created notification document
 */
async function createNotification(orgRef, from, message, event, references = {}) {
  console.log(`[INFO] createNotification => from=${from}, event=${event} at ${formatISTTimestamp()}`);
  
  if (!orgRef) {
    console.log(`[WARN] createNotification => No organisation reference provided`);
    return null;
  }
  
  try {
    // Create notification document with required fields and references
    const notificationData = {
      from: from,
      message: message,
      timestamp: getCurrentIndianTime(),
      seen: false,
      event: event,
      // Add reference fields if provided
      ...references
    };
    
    // Add document to the Notifications subcollection
    const notificationRef = await orgRef.collection("Notifications").add(notificationData);
    console.log(`[INFO] Created notification => event=${event}, id=${notificationRef.id} at ${formatISTTimestamp()}`);
    
    return notificationRef;
  } catch (err) {
    console.error(`[ERROR] Failed to create notification: ${err}`);
    return null;
  }
}

// ----------------------------------------------------------------------
// Welcome Template for Registration
// ----------------------------------------------------------------------
async function sendWelcomeTemplate(userPhone, pocName = "User", orgName = "Test Hospital") {
  console.log(`[INFO] sendWelcomeTemplate => phone=${userPhone} at ${formatISTTimestamp()}`);
  const phoneId = WHATSAPP_PHONE_ID;
  const token = WHATSAPP_TOKEN;
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

  let payload = {
    messaging_product: "whatsapp",
    to: userPhone,
    type: "template",
    template: {
      name: "welcome",
      language: {
        code: "en",
        policy: "deterministic"
      },
      components: [
        {
          type: "header",
          parameters: [
            {
              type: "text",
              text: orgName
            }
          ]
        },
        {
          type: "body",
          parameters: [
            {
              type: "text",
              text: orgName
            },
            {
              type: "text",
              text: pocName
            }
          ]
        },
        {
          type: "button",
          sub_type: "FLOW",
          index: 0,
          parameters: []
        }
      ]
    }
  };

  try {
    let resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    console.log(`[INFO] sendWelcomeTemplate => status=${resp.status}`);
    let txt = await resp.text();
    console.log(`[INFO] sendWelcomeTemplate => body=${txt}`);
  } catch (e) {
    console.error(`[ERROR] => sendWelcomeTemplate: ${e}`);
  }
}

/**
 * Process registration form submission from the welcome flow
 */
async function processWelcomeFormSubmission(pocRef, flowData, orgId = "Test") {
  console.log(`[INFO] processWelcomeFormSubmission => pocId=${pocRef.id} at ${formatISTTimestamp()}`);
  
  // Extract data from form submission
  const fullName = flowData["screen_0_Full_Name_0"] || "";
  const genderVal = flowData["screen_0_Gender_1"] || "";
  const dobValue = flowData["screen_0_DOB_2"] || "";
  const address = flowData["screen_0_Address_3"] || "";

  // Parse gender from dropdown selection (format: "0_Male", "1_Female", etc.)
  let gender = "NA";
  if (genderVal) {
    const parts = genderVal.split('_');
    if (parts.length > 1) {
      gender = parts[1] || "NA"; // Use the part after underscore
    }
  }

  // Parse date string to timestamp if available
  let dobTs = null;
  if (dobValue) {
    try {
      const dobDate = new Date(dobValue);
      if (!isNaN(dobDate.getTime())) {
        // Convert to IST
        dobDate.setTime(dobDate.getTime() + (5.5 * 60 * 60 * 1000));
        dobTs = admin.firestore.Timestamp.fromDate(dobDate);
      }
    } catch (e) {
      console.error(`[ERROR] Failed to parse DOB: ${e}`);
    }
  }

  // Calculate age from DOB if available
  let age = 0;
  if (dobTs) {
    const today = new Date();
    const birthDate = dobTs.toDate();
    let calculatedAge = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      calculatedAge--;
    }
    age = calculatedAge;
  }

  // Update PoC document
  const updateData = {
    Name: fullName,
    Gender: gender,
    DOB: dobTs,
    Address: address,
    Age: age,
    registered: true, // Mark as registered
    updatedAt: getCurrentIndianTime()
  };

  try {
    await pocRef.update(updateData);
    console.log(`[INFO] PoC registration completed for ${pocRef.id} at ${formatISTTimestamp()}`);
    
    // Also update the Patient subcollection with the same information
    const patientSnap = await pocRef.collection("Patients").limit(1).get();
    if (!patientSnap.empty) {
      const patientRef = patientSnap.docs[0].ref;
      await patientRef.update({
        Name: fullName,
        Gender: gender,
        DOB: dobTs,
        Age: age,
        updatedAt: getCurrentIndianTime()
      });
      console.log(`[INFO] Updated Patient info for PoC ${pocRef.id} at ${formatISTTimestamp()}`);
    }
    
    // Create registration notification
    const orgRef = await getOrganisationRef(orgId);
    if (orgRef) {
      const userPhone = pocRef.data().Phone || "Unknown";
      await createNotification(orgRef, userPhone, `New user ${fullName} completed registration`, "Registration", {
        PoCRef: pocRef,
        userData: {
          name: fullName,
          gender: gender,
          age: age,
          address: address
        }
      });
    }
    
    return true;
  } catch (err) {
    console.error(`[ERROR] Failed to update PoC registration: ${err} at ${formatISTTimestamp()}`);
    return false;
  }
}

/**
 * Create or retrieve a PoC doc by phone and organization.
 * If new, also add a "Patients" subcollection doc.
 * PoCs are now differentiated by both phone number AND organization ID.
 * All timestamps use Indian Standard Time.
 * New PoCs are marked as unregistered and sent a welcome template.
 */
async function getOrCreatePoCByPhone(phone, contactName, orgId = "Test") {
  console.log(`[INFO] getOrCreatePoCByPhone => phone=${phone}, org=${orgId}`);
  
  // Updated query to check both phone AND organization
  let snap = await db
    .collection("PoC")
    .where("Phone", "==", phone)
    .where("addedBy", "==", orgId)
    .limit(1)
    .get();

  if (!snap.empty) {
    // Already exists - update lastSeen timestamp
    const pocRef = snap.docs[0].ref;
    await updatePoCLastSeen(pocRef);
    console.log(`[INFO] Found existing PoC => phone=${phone}, org=${orgId}`);
    return pocRef;
  }

  // Not found => create new PoC with addedBy field, lastSeen timestamp and registered=false
  let safeName = contactName;
  let newDoc = await db.collection("PoC").add({
    Name: safeName,
    Phone: phone,
    BotMode: true,
    addedBy: orgId, // Add the new field to track organization
    Created_Timestamp: getCurrentIndianTime(), // Using IST
    lastSeen: getCurrentIndianTime(), // Add initial lastSeen field with Indian time
    registered: false // New field to track registration status
  });
  console.log(`[INFO] Created new PoC => ${newDoc.id} for org=${orgId} at ${formatISTTimestamp()}`);

  // Send welcome template to the new user
  const orgRef = await getOrganisationRef(orgId);
  let orgName = "Test Hospital";
  if (orgRef) {
    const orgDoc = await orgRef.get();
    if (orgDoc.exists && orgDoc.data().OrgName) {
      orgName = orgDoc.data().OrgName;
    }
    
    // Create notification for new user
    await createNotification(orgRef, phone, `New user ${safeName} created an account`, "NewUser", {
      PoCRef: newDoc
    });
  }
  await sendWelcomeTemplate(phone, safeName, orgName);

  // If PoC name == contact name => relation=Self, else blank
  let relationVal = "";
  if (safeName.trim().toLowerCase() === safeName.trim().toLowerCase()) {
    relationVal = "Self";
  }

  // Create the initial patient doc for the new PoC - All timestamps in IST
  await newDoc.collection("Patients").add({
    Name: safeName,
    Gender: "NA",
    Age: 0,
    Relation: relationVal,
    DOB: getCurrentIndianTime(), // Using IST instead of now()
    createdAt: getCurrentIndianTime(), // Using IST instead of serverTimestamp
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
    Timestamp: getCurrentIndianTime(), // Using IST instead of serverTimestamp
    ...extraFields,
  };
  await pocRef.collection("Chat").add(data);
  
  // Update lastSeen timestamp with Indian time
  await updatePoCLastSeen(pocRef);
  
  console.log(
    `[INFO] Chat => direction=${direction}, from=${from}, to=${to}, msgType=${msgType} at ${formatISTTimestamp()}`
  );
}

// ----------------------------------------------------------------------
// Download from WA => upload to GCS => public link
// ----------------------------------------------------------------------
async function downloadWhatsAppMediaAndUpload(mediaId, mimeType = "application/octet-stream") {
  try {
    const token = WHATSAPP_TOKEN;
    let metaUrl = `https://graph.facebook.com/v17.0/${mediaId}`;
    let metaResp = await fetch(metaUrl, {
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

    let fileResp = await fetch(metaJson.url, {
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
    console.log(`[INFO] media upload success => ${publicUrl} at ${formatISTTimestamp()}`);
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
          flow_name: "Appointment",
          flow_cta: "Book Appointment Now!",
        },
      },
    },
  };

  try {
    let resp = await fetch(url, {
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

async function createAppointmentDoc(pocRef, userPhone, flowData, orgId = "Test") {
  console.log(`[INFO] createAppointmentDoc => userPhone=${userPhone}, orgId=${orgId}`);
  let { flow_token, doctorId, date, time, reason, name, age, gender, specialty } = flowData || {};
  let patientName = name;

  // parse date => timestamp
  let dateTs = null;
  if (date) {
    let d = new Date(date);
    if (!isNaN(d.getTime())) {
      // Convert to IST by adding 5.5 hours
      d.setTime(d.getTime() + (5.5 * 60 * 60 * 1000));
      dateTs = admin.firestore.Timestamp.fromDate(d);
    }
  }

  const orgRef = await getOrganisationRef(orgId);
  if (!orgRef) {
    console.log(`[WARN] no Org doc for ${orgId} => cannot create appointment`);
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
    createdAt: getCurrentIndianTime(), // Using IST instead of serverTimestamp
    status: "Draft",
    date: date || "",
    dateTimestamp: dateTs || null,
    FlowToken: flow_token || "",
    OrgID: orgId, // Add organization ID to appointment
  };

  let aptRef = orgRef.collection("Appointment").doc(aptId);
  await aptRef.set(aptDoc);
  console.log(`[INFO] Appointment => /Organisation/${orgId}/Appointment/${aptId} created at ${formatISTTimestamp()}`);

  // Create notification for new appointment with references
  const notificationMessage = `New appointment created for ${patientName} with Dr. ${doctorName} on ${date} at ${time}`;
  await createNotification(orgRef, userPhone, notificationMessage, "Appointment", {
    PoCRef: pocRef, 
    appointmentRef: aptRef,
    doctorRef: doctorRef
  });

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
    DOB: getCurrentIndianTime(), // Using IST instead of now()
    Gender: gender,
    Relation: newRelation,
    reason: reason || "",
    appointmentId: aptId,
    specialty: specialty || "",
    date: date || "",
    time: time || "",
    createdAt: getCurrentIndianTime(), // Using IST instead of serverTimestamp
    OrgID: orgId, // Add organization ID to patient record
  });
  console.log(
    `[INFO] New Patient doc added to PoC/${pocRef.id}/Patients => name="${patientName}" for org=${orgId} at ${formatISTTimestamp()}`
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
    let resp = await fetch(url, {
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

async function createSupportTicket(pocRef, userId, flowData, orgId = "Test") {
  console.log(`[INFO] createSupportTicket => userId=${userId}, orgId=${orgId}`);

  const orgRef = await getOrganisationRef(orgId);
  if (!orgRef) {
    console.log(`[WARN] no Org doc for ${orgId} => cannot create ticket`);
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
    createdAt: getCurrentIndianTime(), // Using IST instead of serverTimestamp
    OrgID: orgId, // Add organization ID
  };
  let ticketRef = orgRef.collection("Ticket").doc(ticketId);
  await ticketRef.set(doc);
  console.log(`[INFO] Created Ticket => /Organisation/${orgId}/Ticket/${ticketId} at ${formatISTTimestamp()}`);
  
  // Get the user's phone number from PoC reference
  let pocSnap = await pocRef.get();
  let userPhone = pocSnap.exists && pocSnap.data().Phone ? pocSnap.data().Phone : "Unknown";
  let userName = pocSnap.exists && pocSnap.data().Name ? pocSnap.data().Name : "User";
  
  // Create notification for new ticket with references
  const notificationMessage = `New support ticket created by ${userName} with ${urgency} urgency in the ${category} category`;
  await createNotification(orgRef, userPhone, notificationMessage, "Ticket", {
    PoCRef: pocRef,
    ticketRef: ticketRef,
    ticketDetails: {
      urgency,
      category,
      description: description ? (description.length > 50 ? description.substring(0, 50) + "..." : description) : ""
    }
  });
}

// ----------------------------------------------------------------------
// Checkin flow
// ----------------------------------------------------------------------
async function createCheckinDoc(pocRef, userPhone, orgId = "Test") {
  console.log(`[INFO] createCheckinDoc => phone=${userPhone}, orgId=${orgId}`);
  const orgRef = await getOrganisationRef(orgId);
  if (!orgRef) {
    console.log(`[WARN] no Org doc for ${orgId} => cannot create checkin`);
    return;
  }
  
  // Get user name for more meaningful notifications
  let pocSnap = await pocRef.get();
  let pocData = pocSnap.exists ? pocSnap.data() : {};
  let userName = pocData.Name || "User";
  
  let checkinId = "CHK-" + generateId(8);
  let doc = {
    CheckinID: checkinId,
    PoCRef: pocRef,
    phone: userPhone,
    checkinTime: getCurrentIndianTime(), // Using IST instead of serverTimestamp
    OrgID: orgId, // Add organization ID
  };
  let checkinRef = orgRef.collection("Checkin").doc(checkinId);
  await checkinRef.set(doc);
  console.log(`[INFO] Created Checkin => /Organisation/${orgId}/Checkin/${checkinId} at ${formatISTTimestamp()}`);
  
  // Create notification for checkin
  const notificationMessage = `${userName} just checked in at the facility`;
  await createNotification(orgRef, userPhone, notificationMessage, "Checkin", {
    PoCRef: pocRef,
    checkinRef: checkinRef
  });
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
  console.log(`[INFO] knowledgeLookupImpl => q="${userQuery}" at ${formatISTTimestamp()}`);
  if (!knowledgeText || knowledgeText.startsWith("Error")) {
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
  console.log(`[INFO] smallTalkImpl => userMessage="${userMessage}" at ${formatISTTimestamp()}`);
  // Just keep it short and sweet.
  return `Hello! Test Hospital is here to help. How can we assist you today?`;
}

// ----------------------------------------------------------------------
// GPT-based Symptom Classification + Triage
// ----------------------------------------------------------------------
async function symptomAssessmentImpl(userSymptom, orgId = "Test") {
  console.log(`[INFO] symptomAssessment => userSymptom=${userSymptom} at ${formatISTTimestamp()}`);

  let lines = userSymptom
    .split(/(\.|,|\n)/)
    .map((s) => s.trim())
    .filter((x) => x && x.length > 2);

  let resultParts = [];
  for (let line of lines) {
    // 1) Let GPT pick the best specialty from the fixed list
    let gptSpecialty = await classifySymptomWithGpt(line);
    // 2) Then run our fuzzy matching in Doctors collection with organization filter
    let docList = await findDoctorsByFuzzySpecialty(gptSpecialty, orgId);

    // Create a user-friendly message
    let partialMsg = `*Symptom*: "${line}"\nLikely specialty: ${gptSpecialty}.\nDisclaimer: This is basic guidance, not a formal diagnosis. Please consult in person for serious concerns.`;
    if (docList && docList.length > 0) {
      partialMsg += `\n*Possible doctors* matching that specialty:`;
      for (let d of docList) {
        partialMsg += `\n*${d.Name}* (Specialization: ${d.Specialization.join(", ")})`;
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
    "Psychologist",
    "Anesthesiologist",
    "Allergist/Immunologist",
    "Endocrinologist",
    "Hematologist",
    "Infectious Disease Specialist",
    "Pulmonologist",
    "Radiologist",
    "Rheumatologist",
    "Psychiatrist",
    "Ophthalmologist",
    "Plastic Surgeon",
    "Vascular Surgeon",
    "Neonatologist",
    "Geriatrician",
    "Sports Medicine Specialist",
    "Emergency Medicine Physician",
    "Critical Care Specialist",
    "Family Medicine Physician",
    "Pain Management Specialist",
    "Occupational Health Physician",
    "Cardiothoracic Surgeon",
    "Neurosurgeon",
    "Hepatologist",
    "Colorectal Surgeon",
    "Obstetrician",
    "Andrologist",
    "Pediatric Surgeon",
    "Medical Geneticist",
    "Forensic Pathologist",
    "Maxillofacial Surgeon",
    "Transplant Surgeon",
    "Nuclear Medicine Physician",
    "Interventional Radiologist",
    "Palliative Care Specialist"
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
    console.log(`[INFO] GPT classified symptom => "${symptomLine}" => ${specialty} at ${formatISTTimestamp()}`);
    return specialty;
  } catch (err) {
    console.error("[ERROR] classifySymptomWithGpt =>", err);
    return "General Physician";
  }
}

// ----------------------------------------------------------------------
// Naive fuzzy matching with doc's .Specialization - now organization specific
// ----------------------------------------------------------------------
async function findDoctorsByFuzzySpecialty(specialty, orgId = "Test") {
  try {
    // Updated to filter by organization
    let snap = await db.collection("Doctors").where("OrgID", "==", orgId).get();
    if (snap.empty) {
      console.log(`[INFO] no doctors for organization ${orgId}`);
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
    console.error(`[ERROR] findDoctorsByFuzzySpecialty => ${err}`);
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
async function updateAppointmentFeedback(flowData, orgId = "Test") {
  console.log(`[INFO] updateAppointmentFeedback => orgId=${orgId} at ${formatISTTimestamp()}`);
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

  const orgRef = await getOrganisationRef(orgId);
  if (!orgRef) {
    console.log(`[WARN] no Org doc for ${orgId} => can't store feedback`);
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
  let aptDoc = aptSnap.docs[0].data();
  let pocRef = aptDoc.PoCRef;
  let userPhone = aptDoc.userPhone || "Unknown";

  let feedback = {
    Recommend: recommend,
    Comments: comments,
    Staff_Experience: staffExp,
    Doctor_consultation: docConsult,
    Overall_Experience: overallExp,
    submittedAt: getCurrentIndianTime(), // Using IST instead of serverTimestamp
  };

  await aptRef.update({ feedback });
  console.log(`[INFO] feedback updated => doc=${aptRef.id} at ${formatISTTimestamp()}`);
  
  // Create notification for feedback submission
  const overallRating = overallExp !== "NA" ? `${overallExp}/5` : "N/A";
  const notificationMessage = `Feedback received for appointment with Dr. ${aptDoc.doctorName || "Unknown"}. Overall rating: ${overallRating}`;
  await createNotification(orgRef, userPhone, notificationMessage, "Feedback", {
    PoCRef: pocRef,
    appointmentRef: aptRef,
    feedbackDetails: {
      recommend,
      comments: comments ? (comments.length > 50 ? comments.substring(0, 50) + "..." : comments) : "",
      staffExp,
      docConsult,
      overallExp
    }
  });
}

// ----------------------------------------------------------------------
// 8) handleLocalFunctionCall
// ----------------------------------------------------------------------
async function handleLocalFunctionCall(name, args, fromPhone, userId, userQuery, orgId = "Test") {
  console.log(`[INFO] handleLocalFunctionCall => name=${name}, orgId=${orgId} at ${formatISTTimestamp()}`);
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
      return await symptomAssessmentImpl(args.userSymptom || "", orgId);

    default:
      return "Kindly only ask anything related to Test Hospital.";
  }
}

async function handleOpenAiFunctionCall(fCall, fromPhone, userId, userQuery, orgId = "Test") {
  console.log(`[INFO] handleOpenAiFunctionCall => functionName="${fCall.name}", orgId=${orgId} at ${formatISTTimestamp()}`);
  try {
    let parsed = JSON.parse(fCall.arguments);
    return await handleLocalFunctionCall(fCall.name, parsed, fromPhone, userId, userQuery, orgId);
  } catch (e) {
    console.error("[ERROR] handleOpenAiFunctionCall => parse error:", e);
    return "Error parsing function arguments.";
  }
}

// ----------------------------------------------------------------------
// 9) sendWhatsAppMessage
// ----------------------------------------------------------------------
async function sendWhatsAppMessage(to, message) {
  console.log(`[INFO] sendWhatsAppMessage => to=${to}, msg="${message}" at ${formatISTTimestamp()}`);
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
    let resp = await fetch(url, {
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
// Express App for the Cloud Function
// ----------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/webhook", (req, res) => {
  const verifyToken = VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  console.log(`[INFO] GET /webhook => mode=${mode}, token=${token} at ${formatISTTimestamp()}`);
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
    console.log(`[INFO] POST /webhook => incoming at ${formatISTTimestamp()}`);
    if (!req.body.object) return res.sendStatus(404);

    // Get organization ID from request context
    const orgId = await getOrganizationFromContext(req);

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

    // A) nfm_reply => either support, appointment, feedback or welcome flow
    if (msg && msg.interactive && msg.interactive.type === "nfm_reply") {
      console.log(
        `[INFO] nfm_reply => parse => checking message type (org=${orgId}) at ${formatISTTimestamp()}`
      );
      const fromUser = msg.from;
      let rawJson = msg.interactive.nfm_reply.response_json;
      let flowData = JSON.parse(rawJson);

      const pocRef = await getOrCreatePoCByPhone(fromUser, contactName, orgId);
      let shortFlow = JSON.stringify(flowData);
      if (shortFlow.length > 300) shortFlow = shortFlow.slice(0, 300) + "...(truncated)";

      // Store incoming form data
      await saveChatToPoC(
        pocRef,
        "inbound",
        fromUser,
        WHATSAPP_PHONE_ID,
        "interactive",
        shortFlow
      );

      // Check if welcome registration form (contains Full Name field)
      if (flowData["screen_0_Full_Name_0"]) {
        // Process welcome/registration form
        console.log(`[INFO] Processing welcome form submission from ${fromUser} at ${formatISTTimestamp()}`);
        await processWelcomeFormSubmission(pocRef, flowData, orgId);
        let welcomeMsg = "Thank you for completing your registration! You can now use our services.";
        await sendWhatsAppMessage(fromUser, welcomeMsg);
        await saveChatToPoC(
          pocRef,
          "outbound",
          WHATSAPP_PHONE_ID,
          fromUser,
          "text",
          welcomeMsg
        );
      }
      // Other form types
      else if (flowData["screen_0_Choose_0"]) {
        // => feedback
        await updateAppointmentFeedback(flowData, orgId);
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
      else if (flowData["screen_0_Description_of_issue_2"]) {
        // => support
        await createSupportTicket(pocRef, pocRef.id, flowData, orgId);
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
        await createAppointmentDoc(pocRef, fromUser, flowData, orgId);
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
      const pocRef = await getOrCreatePoCByPhone(from, contactName, orgId);

      if (["image", "video", "audio", "document"].includes(msg.type)) {
        // handle media
        console.log(`[INFO] user ${from} sends media => type=${msg.type} (org=${orgId}) at ${formatISTTimestamp()}`);
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
        
        // Create notification for media message
        const orgRef = await getOrganisationRef(orgId);
        if (orgRef) {
          // Get user name for more meaningful notifications
          let pocSnap = await pocRef.get();
          let pocData = pocSnap.exists ? pocSnap.data() : {};
          let userName = pocData.Name || "User";
          
          const mediaTypeMap = {
            "image": "an image",
            "video": "a video",
            "audio": "an audio message",
            "document": "a document"
          };
          
          const notificationMessage = `${userName} sent ${mediaTypeMap[msg.type] || "a media file"}`;
          await createNotification(orgRef, from, notificationMessage, "Message", {
            PoCRef: pocRef,
            mediaType: msg.type,
            mediaUrl: publicUrl
          });
        }

        return res.sendStatus(200);
      } else if (msg.type === "text") {
        const userText = msg.text.body || "";
        console.log(`[INFO] user(${from}) => text="${userText}" (org=${orgId}) at ${formatISTTimestamp()}`);
        await saveChatToPoC(pocRef, "inbound", from, WHATSAPP_PHONE_ID, "text", userText);
        
        // Create notification for new message if it's not a special command and has meaningful content
        if (!userText.startsWith("Checkin:") && userText.length > 10) {
          const orgRef = await getOrganisationRef(orgId);
          if (orgRef) {
            // Get user name for more meaningful notifications
            let pocSnap = await pocRef.get();
            let pocData = pocSnap.exists ? pocSnap.data() : {};
            let userName = pocData.Name || "User";
            
            const notificationMessage = `New message from ${userName}: "${userText.length > 30 ? userText.substring(0, 30) + '...' : userText}"`;
            await createNotification(orgRef, from, notificationMessage, "Message", {
              PoCRef: pocRef,
              messageContent: userText
            });
          }
        }

        // "Checkin:Test" => create doc
        if (userText.startsWith("Checkin:")) {
          let checkVal = userText.split(":")[1] || "";
          if (checkVal.trim() === orgId) {
            await createCheckinDoc(pocRef, from, orgId);
            let checkAck = `Welcome to ${orgId}! Check-in recorded. Please proceed!`;
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

        console.log(`[INFO] calling openai => function_call=auto at ${formatISTTimestamp()}`);
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
          console.log(`[INFO] AI calls function => ${fc.name} (org=${orgId}) at ${formatISTTimestamp()}`);
          reply = await handleOpenAiFunctionCall(fc, from, pocRef.id, userText, orgId);
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
    console.error(`[ERROR] => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/migrate-pocs", async (req, res) => {
  try {
    console.log(`[INFO] Running migration at ${formatISTTimestamp()}`);
    const secret = req.query.secret;
    // Only run with proper authorization
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    const batch = db.batch();
    
    // Find records without addedBy field
    const snapshot1 = await db.collection("PoC").where("addedBy", "==", null).get();
    
    let count1 = 0;
    snapshot1.docs.forEach(doc => {
      batch.update(doc.ref, { 
        addedBy: "Test",
        lastSeen: getCurrentIndianTime()
      });
      count1++;
    });
    
    // Find records without lastSeen field
    const snapshot2 = await db.collection("PoC").where("lastSeen", "==", null).get();
    
    let count2 = 0;
    snapshot2.docs.forEach(doc => {
      if (!doc.data().lastSeen) {
        batch.update(doc.ref, { lastSeen: getCurrentIndianTime() });
        count2++;
      }
    });
    
    // Find records without registered field
    const snapshot3 = await db.collection("PoC").where("registered", "==", null).get();
    
    let count3 = 0;
    snapshot3.docs.forEach(doc => {
      if (doc.data().registered === undefined) {
        batch.update(doc.ref, { registered: true }); // Assume existing users are already registered
        count3++;
      }
    });
    
    if (count1 + count2 + count3 > 0) {
      await batch.commit();
    }
    
    return res.status(200).json({ 
      success: true, 
      message: `Updated ${count1} PoCs with addedBy="Test", ${count2} with lastSeen, and ${count3} with registered=true`,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] migration failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Endpoint to view PoCs across organizations
app.get("/pocs-by-phone", async (req, res) => {
  try {
    const secret = req.query.secret;
    const phone = req.query.phone;
    
    // Only run with proper authorization
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    if (!phone) {
      return res.status(400).json({ error: "Phone number required" });
    }
    
    const results = await findPoCsAcrossOrganizations(phone);
    return res.status(200).json({ 
      success: true,
      count: results.length,
      results,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] PoC lookup failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Add a utility endpoint to send welcome template to specific users
app.get("/send-welcome", async (req, res) => {
  try {
    const secret = req.query.secret;
    const phone = req.query.phone;
    const orgId = req.query.orgId || "Test";
    
    // Only run with proper authorization
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    if (!phone) {
      return res.status(400).json({ error: "Phone number required" });
    }
    
    // Get PoC info
    const pocSnap = await db
      .collection("PoC")
      .where("Phone", "==", phone)
      .where("addedBy", "==", orgId)
      .limit(1)
      .get();
    
    if (pocSnap.empty) {
      return res.status(404).json({ error: "PoC not found" });
    }
    
    const pocData = pocSnap.docs[0].data();
    const pocName = pocData.Name || "User";
    
    // Get org name
    const orgRef = await getOrganisationRef(orgId);
    let orgName = "Test Hospital";
    if (orgRef) {
      const orgDoc = await orgRef.get();
      if (orgDoc.exists && orgDoc.data().OrgName) {
        orgName = orgDoc.data().OrgName;
      }
    }
    
    // Send welcome template
    await sendWelcomeTemplate(phone, pocName, orgName);
    
    return res.status(200).json({
      success: true,
      message: `Welcome template sent to ${phone}`,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] send-welcome failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Endpoint to check registration status of PoCs
app.get("/check-registration", async (req, res) => {
  try {
    const secret = req.query.secret;
    // Only run with proper authorization
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    const orgId = req.query.orgId || "Test";
    
    // Get all PoCs for the organization
    const pocsSnap = await db
      .collection("PoC")
      .where("addedBy", "==", orgId)
      .get();
    
    if (pocsSnap.empty) {
      return res.status(200).json({
        success: true,
        message: `No PoCs found for organization ${orgId}`,
        timestamp: formatISTTimestamp()
      });
    }
    
    // Count registered and unregistered PoCs
    let registered = 0;
    let unregistered = 0;
    const unregisteredPocs = [];
    
    pocsSnap.docs.forEach(doc => {
      const data = doc.data();
      if (data.registered === true) {
        registered++;
      } else {
        unregistered++;
        unregisteredPocs.push({
          id: doc.id,
          phone: data.Phone,
          name: data.Name,
          createdAt: data.Created_Timestamp ? data.Created_Timestamp.toDate().toISOString() : null
        });
      }
    });
    
    return res.status(200).json({
      success: true,
      registered,
      unregistered,
      unregisteredPocs,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] check-registration failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Endpoint to get notifications for an organization
app.get("/notifications", async (req, res) => {
  try {
    const secret = req.query.secret;
    const orgId = req.query.orgId || "Test";
    const limit = parseInt(req.query.limit || "20", 10);
    const eventType = req.query.eventType || null; // Filter by event type if provided
    const unseenOnly = req.query.unseenOnly === 'true'; // Filter for unseen notifications only
    
    // Only run with proper authorization
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    const orgRef = await getOrganisationRef(orgId);
    if (!orgRef) {
      return res.status(404).json({ error: `Organization ${orgId} not found` });
    }
    
    // Build the query with filters
    let notificationsQuery = orgRef.collection("Notifications")
                               .orderBy("timestamp", "desc");
    
    // Add event filter if specified
    if (eventType) {
      notificationsQuery = notificationsQuery.where("event", "==", eventType);
    }
    
    // Add unseen filter if specified
    if (unseenOnly) {
      notificationsQuery = notificationsQuery.where("seen", "==", false);
    }
    
    // Apply limit at the end
    notificationsQuery = notificationsQuery.limit(limit);
    
    const notificationsSnap = await notificationsQuery.get();
    
    // Format notifications for response
    const notifications = notificationsSnap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        from: data.from,
        message: data.message,
        timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
        seen: data.seen === true,
        event: data.event,
        // Include any other reference fields from the document
        ...Object.fromEntries(
          Object.entries(data)
            .filter(([key]) => !['from', 'message', 'timestamp', 'seen', 'event'].includes(key))
        )
      };
    });
    
    return res.status(200).json({
      success: true,
      count: notifications.length,
      notifications,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] get-notifications failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Endpoint to mark notifications as seen
app.post("/notifications/mark-seen", async (req, res) => {
  try {
    const secret = req.query.secret;
    const orgId = req.query.orgId || "Test";
    const notificationIds = req.body.notificationIds || [];
    const markAll = req.body.markAll === true;
    
    // Only run with proper authorization
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    if (!markAll && (!Array.isArray(notificationIds) || notificationIds.length === 0)) {
      return res.status(400).json({ error: "No notification IDs provided and markAll not set to true" });
    }
    
    const orgRef = await getOrganisationRef(orgId);
    if (!orgRef) {
      return res.status(404).json({ error: `Organization ${orgId} not found` });
    }
    
    let count = 0;
    
    if (markAll) {
      // Mark all unseen notifications as seen
      const batch = db.batch();
      const unseenSnap = await orgRef
        .collection("Notifications")
        .where("seen", "==", false)
        .get();
      
      unseenSnap.docs.forEach(doc => {
        batch.update(doc.ref, { seen: true });
        count++;
      });
      
      if (count > 0) {
        await batch.commit();
      }
    } else {
      // Mark specific notifications as seen
      const batch = db.batch();
      
      for (const notificationId of notificationIds) {
        const notificationRef = orgRef.collection("Notifications").doc(notificationId);
        batch.update(notificationRef, { seen: true });
        count++;
      }
      
      await batch.commit();
    }
    
    return res.status(200).json({
      success: true,
      message: markAll ? `Marked all ${count} unseen notifications as seen` : `Marked ${count} notifications as seen`,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] mark-notifications-seen failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Add endpoint to get notification counts by event type
app.get("/notification-counts", async (req, res) => {
  try {
    const secret = req.query.secret;
    const orgId = req.query.orgId || "Test";
    
    // Only run with proper authorization
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    const orgRef = await getOrganisationRef(orgId);
    if (!orgRef) {
      return res.status(404).json({ error: `Organization ${orgId} not found` });
    }
    
    // Get all notifications
    const notificationsSnap = await orgRef.collection("Notifications").get();
    
    // Count by event type and seen status
    const counts = {
      total: notificationsSnap.size,
      unseen: 0,
      byEventType: {},
      unseenByEventType: {}
    };
    
    notificationsSnap.docs.forEach(doc => {
      const data = doc.data();
      const eventType = data.event || 'Unknown';
      const seen = data.seen === true;
      
      // Initialize counters if they don't exist
      if (!counts.byEventType[eventType]) {
        counts.byEventType[eventType] = 0;
      }
      if (!counts.unseenByEventType[eventType]) {
        counts.unseenByEventType[eventType] = 0;
      }
      
      // Increment total counts
      counts.byEventType[eventType]++;
      
      // Track unseen counts
      if (!seen) {
        counts.unseen++;
        counts.unseenByEventType[eventType]++;
      }
    });
    
    return res.status(200).json({
      success: true,
      counts,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] notification-counts failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Add basic route for health check
app.get("/", (req, res) => {
  res.status(200).json({
    message: "Test Hospital HRM Bot is running!",
    timestamp: formatISTTimestamp(),
    timezone: "IST (UTC+5:30)"
  });
});

// Register the Express app as a Cloud Function
functions.http('Test', app);