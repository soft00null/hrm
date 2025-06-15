"use strict";

const express = require("express");
const admin = require("firebase-admin");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args)); // ESM import for Node.js 22
const { Configuration, OpenAIApi } = require("openai");
const fs = require('fs/promises');
const path = require('path');
const functions = require('@google-cloud/functions-framework');

// ----------------------------------------------------------------------
// Multi-tenant configuration - removed hard-coded values
// ----------------------------------------------------------------------
// Organization configurations are now stored in Firestore
let organizationConfigs = new Map(); // Cache for organization configs

// OpenAI is shared across all organizations
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

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
// Multi-tenant Organization Configuration Management
// ----------------------------------------------------------------------

/**
 * Load organization configuration from Firestore
 * @param {string} orgId - Organization ID
 * @returns {Promise<Object|null>} Organization configuration
 */
async function loadOrganizationConfig(orgId) {
  try {
    // Check cache first
    if (organizationConfigs.has(orgId)) {
      return organizationConfigs.get(orgId);
    }

    // Load from Firestore
    const orgSnap = await db
      .collection("Organisation")
      .where("OrgID", "==", orgId)
      .limit(1)
      .get();

    if (orgSnap.empty) {
      console.log(`[WARN] Organization ${orgId} not found in database`);
      return null;
    }

    const orgData = orgSnap.docs[0].data();
    const config = {
      orgId: orgId,
      orgName: orgData.Name || orgData.OrgName || orgId,
      whatsappToken: orgData.WA_Token || '',
      whatsappPhoneId: orgData.WA_Phone_ID || orgData.FB_Number || '',
      verifyToken: orgData.WA_Verify_Token || 'default_verify_token',
      billingActive: orgData.BillingActive === true,
      billingPlan: orgData.BillingPlan || 'Basic',
      knowledgeUrl: orgData.Knowledge_URL || '',
      services: orgData.Services || [],
      doctorList: orgData.DoctorList || [],
      orgLogo: orgData.OrgLogo || '',
      orgRef: orgSnap.docs[0].ref
    };

    // Cache the configuration
    organizationConfigs.set(orgId, config);
    console.log(`[INFO] Loaded configuration for organization: ${orgId}`);
    return config;
  } catch (err) {
    console.error(`[ERROR] Failed to load organization config for ${orgId}:`, err);
    return null;
  }
}

/**
 * Get organization ID from WhatsApp phone number
 * @param {string} phoneId - WhatsApp Phone ID
 * @returns {Promise<string|null>} Organization ID
 */
async function getOrganizationByPhoneId(phoneId) {
  try {
    const orgSnap = await db
      .collection("Organisation")
      .where("WA_Phone_ID", "==", phoneId)
      .limit(1)
      .get();

    if (!orgSnap.empty) {
      return orgSnap.docs[0].data().OrgID;
    }

    // Fallback: try FB_Number field
    const orgSnap2 = await db
      .collection("Organisation")
      .where("FB_Number", "==", phoneId)
      .limit(1)
      .get();

    if (!orgSnap2.empty) {
      return orgSnap2.docs[0].data().OrgID;
    }

    console.log(`[WARN] No organization found for phone ID: ${phoneId}`);
    return null;
  } catch (err) {
    console.error(`[ERROR] Failed to get organization by phone ID:`, err);
    return null;
  }
}

/**
 * Refresh organization configuration cache
 * @param {string} orgId - Organization ID to refresh
 */
async function refreshOrganizationConfig(orgId) {
  organizationConfigs.delete(orgId);
  return await loadOrganizationConfig(orgId);
}

/**
 * Get all active organizations
 * @returns {Promise<Array>} List of active organizations
 */
async function getAllActiveOrganizations() {
  try {
    const orgSnap = await db
      .collection("Organisation")
      .where("BillingActive", "==", true)
      .get();

    return orgSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  } catch (err) {
    console.error("[ERROR] Failed to get active organizations:", err);
    return [];
  }
}

// ----------------------------------------------------------------------
// 3) Knowledge base management - now organization-specific
// ----------------------------------------------------------------------
let knowledgeCache = new Map(); // Cache for organization knowledge bases

/**
 * Load knowledge base for an organization
 * @param {string} orgId - Organization ID
 * @returns {Promise<string>} Knowledge base content
 */
async function loadKnowledgeBase(orgId) {
  try {
    // Check cache first
    if (knowledgeCache.has(orgId)) {
      return knowledgeCache.get(orgId);
    }

    const orgConfig = await loadOrganizationConfig(orgId);
    if (!orgConfig) {
      return "No organization configuration found.";
    }

    let knowledgeText = "No knowledge base loaded.";

    // Try loading from URL first
    if (orgConfig.knowledgeUrl) {
      try {
        const response = await fetch(orgConfig.knowledgeUrl);
        if (response.ok) {
          knowledgeText = await response.text();
          console.log(`[INFO] Loaded knowledge from URL for ${orgId}, length=${knowledgeText.length}`);
        }
      } catch (urlErr) {
        console.error(`[ERROR] Failed to load knowledge from URL for ${orgId}:`, urlErr);
      }
    }

    // Fallback to local file with org-specific name
    if (knowledgeText === "No knowledge base loaded.") {
      const knowledgebasePath = path.join(__dirname, `knowledgebase_${orgId}.txt`);
      try {
        knowledgeText = await fs.readFile(knowledgebasePath, 'utf8');
        console.log(`[INFO] Loaded knowledge from local file for ${orgId}, length=${knowledgeText.length}`);
      } catch (fileErr) {
        // Try default knowledgebase.txt
        const defaultPath = path.join(__dirname, 'knowledgebase.txt');
        try {
          knowledgeText = await fs.readFile(defaultPath, 'utf8');
          console.log(`[INFO] Loaded default knowledge base for ${orgId}, length=${knowledgeText.length}`);
        } catch (defaultErr) {
          console.error(`[ERROR] No knowledge base found for ${orgId}`);
          knowledgeText = `No knowledge base available for ${orgConfig.orgName}.`;
        }
      }
    }

    // Cache the knowledge base
    knowledgeCache.set(orgId, knowledgeText);
    return knowledgeText;
  } catch (err) {
    console.error(`[ERROR] Failed to load knowledge base for ${orgId}:`, err);
    return "Error loading knowledge base.";
  }
}

// ----------------------------------------------------------------------
// Utility: Get Current Indian Time (IST = UTC+5:30)
// ----------------------------------------------------------------------
function getCurrentIndianTime() {
  return admin.firestore.Timestamp.now();
}

function formatISTTimestamp() {
  const now = new Date();
  const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const year = istTime.getUTCFullYear();
  const month = String(istTime.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istTime.getUTCDate()).padStart(2, '0');
  const hours = String(istTime.getUTCHours()).padStart(2, '0');
  const minutes = String(istTime.getUTCMinutes()).padStart(2, '0');
  const seconds = String(istTime.getUTCSeconds()).padStart(2, '0');
  
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
// Enhanced context detection for multi-tenant support
// ----------------------------------------------------------------------
async function getOrganizationFromContext(req) {
  try {
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
    
    // Option 3: Get from WhatsApp webhook data
    const entry = (req.body.entry && req.body.entry[0]) || {};
    const changes = (entry.changes && entry.changes[0]) || {};
    const value = changes.value || {};
    
    // Try to get phone ID from webhook data
    let phoneId = null;
    if (value.metadata && value.metadata.phone_number_id) {
      phoneId = value.metadata.phone_number_id;
    } else if (value.phone_number_id) {
      phoneId = value.phone_number_id;
    }
    
    if (phoneId) {
      const orgId = await getOrganizationByPhoneId(phoneId);
      if (orgId) {
        console.log(`[INFO] Found organization ${orgId} for phone ID: ${phoneId}`);
        return orgId;
      }
    }
    
    // Option 4: Try to get from message context
    const msg = (value.messages && value.messages[0]) || null;
    if (msg && msg.context && msg.context.organization_id) {
      const orgId = msg.context.organization_id;
      console.log(`[INFO] Using organization ID from message context: ${orgId}`);
      return orgId;
    }
    
    // Option 5: Try to get from metadata
    if (value && value.metadata && value.metadata.organization_id) {
      const orgId = value.metadata.organization_id;
      console.log(`[INFO] Using organization ID from metadata: ${orgId}`);
      return orgId;
    }
    
    // Default fallback
    console.log(`[WARN] Could not determine organization from context, using default: Saijyot`);
    return "Saijyot";
  } catch (err) {
    console.error("[ERROR] getOrganizationFromContext:", err);
    return "Saijyot";
  }
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
// Tools definition - now organization-aware
// ----------------------------------------------------------------------
function getOpenAiTools(orgId) {
  return [
    {
      name: "appointment_flow",
      description: `Handles new/reschedule/cancel appointment. 'new' => send interactive form => user fills => create doc in /Organisation/${orgId}/Appointment`,
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
      description: `Send 'support' template => user fills => parse => create doc in /Organisation/${orgId}/Ticket (support ticket).`,
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
      description: `Answers user questions about ${orgId} using only the loaded knowledgeBase text. This includes founders, services, specialties, mission, vision, core values, insurance, TPAs, doctors & schedules, contact details, location, or any other info from knowledgeBase. 1) Substring search to find relevant lines 2) GPT fallback with those lines. No hallucination – only info from knowledgeBase should be used.`,
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
      description: `Triage user symptoms => disclaimers => suggests real doctors (from Firestore) for the user's symptom. No made-up doctor names. GPT is used to classify the symptom into one known specialty, then you fetch matching doctors for ${orgId}.`,
      parameters: {
        type: "object",
        properties: {
          userSymptom: { type: "string" },
        },
        required: ["userSymptom"],
      },
    }
  ];
}

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

/**
 * Create a notification in the Organisation's Notifications subcollection with extended fields
 */
async function createNotification(orgRef, from, message, event, references = {}) {
  console.log(`[INFO] createNotification => from=${from}, event=${event} at ${formatISTTimestamp()}`);
  
  if (!orgRef) {
    console.log(`[WARN] createNotification => No organisation reference provided`);
    return null;
  }
  
  try {
    const notificationData = {
      from: from,
      message: message,
      timestamp: getCurrentIndianTime(),
      seen: false,
      event: event,
      ...references
    };
    
    const notificationRef = await orgRef.collection("Notifications").add(notificationData);
    console.log(`[INFO] Created notification => event=${event}, id=${notificationRef.id} at ${formatISTTimestamp()}`);
    
    return notificationRef;
  } catch (err) {
    console.error(`[ERROR] Failed to create notification: ${err}`);
    return null;
  }
}

// ----------------------------------------------------------------------
// Multi-tenant WhatsApp messaging
// ----------------------------------------------------------------------
async function sendWhatsAppMessage(to, message, orgId) {
  console.log(`[INFO] sendWhatsAppMessage => to=${to}, msg="${message}", org=${orgId} at ${formatISTTimestamp()}`);
  
  const orgConfig = await loadOrganizationConfig(orgId);
  if (!orgConfig) {
    console.error(`[ERROR] No configuration found for organization: ${orgId}`);
    return false;
  }

  if (!orgConfig.whatsappToken || !orgConfig.whatsappPhoneId) {
    console.error(`[ERROR] Missing WhatsApp credentials for organization: ${orgId}`);
    return false;
  }

  const token = orgConfig.whatsappToken;
  const phoneId = orgConfig.whatsappPhoneId;
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
    return resp.ok;
  } catch (e) {
    console.error("[ERROR] => sendWhatsAppMessage:", e);
    return false;
  }
}

// ----------------------------------------------------------------------
// Welcome Template for Registration - now organization-aware
// ----------------------------------------------------------------------
async function sendWelcomeTemplate(userPhone, pocName = "User", orgId = "Saijyot") {
  console.log(`[INFO] sendWelcomeTemplate => phone=${userPhone}, org=${orgId} at ${formatISTTimestamp()}`);
  
  const orgConfig = await loadOrganizationConfig(orgId);
  if (!orgConfig) {
    console.error(`[ERROR] No configuration found for organization: ${orgId}`);
    return false;
  }

  const phoneId = orgConfig.whatsappPhoneId;
  const token = orgConfig.whatsappToken;
  const orgName = orgConfig.orgName;
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
    return resp.ok;
  } catch (e) {
    console.error(`[ERROR] => sendWelcomeTemplate: ${e}`);
    return false;
  }
}

/**
 * Process registration form submission from the welcome flow
 */
async function processWelcomeFormSubmission(pocRef, flowData, orgId) {
  console.log(`[INFO] processWelcomeFormSubmission => pocId=${pocRef.id}, org=${orgId} at ${formatISTTimestamp()}`);
  
  const fullName = flowData["screen_0_Full_Name_0"] || "";
  const genderVal = flowData["screen_0_Gender_1"] || "";
  const dobValue = flowData["screen_0_DOB_2"] || "";
  const address = flowData["screen_0_Address_3"] || "";

  let gender = "NA";
  if (genderVal) {
    const parts = genderVal.split('_');
    if (parts.length > 1) {
      gender = parts[1] || "NA";
    }
  }

  let dobTs = null;
  if (dobValue) {
    try {
      const dobDate = new Date(dobValue);
      if (!isNaN(dobDate.getTime())) {
        dobDate.setTime(dobDate.getTime() + (5.5 * 60 * 60 * 1000));
        dobTs = admin.firestore.Timestamp.fromDate(dobDate);
      }
    } catch (e) {
      console.error(`[ERROR] Failed to parse DOB: ${e}`);
    }
  }

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

  const updateData = {
    Name: fullName,
    Gender: gender,
    DOB: dobTs,
    Address: address,
    Age: age,
    registered: true,
    updatedAt: getCurrentIndianTime()
  };

  try {
    await pocRef.update(updateData);
    console.log(`[INFO] PoC registration completed for ${pocRef.id} at ${formatISTTimestamp()}`);
    
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
    
    const orgRef = await getOrganisationRef(orgId);
    if (orgRef) {
      const pocData = await pocRef.get();
      const userPhone = pocData.data().Phone || "Unknown";
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
 */
async function getOrCreatePoCByPhone(phone, contactName, orgId) {
  console.log(`[INFO] getOrCreatePoCByPhone => phone=${phone}, org=${orgId}`);
  
  let snap = await db
    .collection("PoC")
    .where("Phone", "==", phone)
    .where("addedBy", "==", orgId)
    .limit(1)
    .get();

  if (!snap.empty) {
    const pocRef = snap.docs[0].ref;
    await updatePoCLastSeen(pocRef);
    console.log(`[INFO] Found existing PoC => phone=${phone}, org=${orgId}`);
    return pocRef;
  }

  let safeName = contactName;
  let newDoc = await db.collection("PoC").add({
    Name: safeName,
    Phone: phone,
    BotMode: true,
    addedBy: orgId,
    Created_Timestamp: getCurrentIndianTime(),
    lastSeen: getCurrentIndianTime(),
    registered: false
  });
  console.log(`[INFO] Created new PoC => ${newDoc.id} for org=${orgId} at ${formatISTTimestamp()}`);

  const orgRef = await getOrganisationRef(orgId);
  if (orgRef) {
    await createNotification(orgRef, phone, `New user ${safeName} created an account`, "NewUser", {
      PoCRef: newDoc
    });
  }
  
  await sendWelcomeTemplate(phone, safeName, orgId);

  let relationVal = "";
  if (safeName.trim().toLowerCase() === safeName.trim().toLowerCase()) {
    relationVal = "Self";
  }

  await newDoc.collection("Patients").add({
    Name: safeName,
    Gender: "NA",
    Age: 0,
    Relation: relationVal,
    DOB: getCurrentIndianTime(),
    createdAt: getCurrentIndianTime(),
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
    Timestamp: getCurrentIndianTime(),
    ...extraFields,
  };
  await pocRef.collection("Chat").add(data);
  
  await updatePoCLastSeen(pocRef);
  
  console.log(
    `[INFO] Chat => direction=${direction}, from=${from}, to=${to}, msgType=${msgType} at ${formatISTTimestamp()}`
  );
}

// ----------------------------------------------------------------------
// Download from WA => upload to GCS => public link - now organization-aware
// ----------------------------------------------------------------------
async function downloadWhatsAppMediaAndUpload(mediaId, mimeType = "application/octet-stream", orgId) {
  try {
    const orgConfig = await loadOrganizationConfig(orgId);
    if (!orgConfig) {
      console.error(`[ERROR] No configuration found for organization: ${orgId}`);
      return null;
    }

    const token = orgConfig.whatsappToken;
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
    let fileName = `${orgId}/${mediaId}.${ext}`;
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
// Appointment flow - now organization-aware
// ----------------------------------------------------------------------
async function sendAppointmentFlow(userPhone, orgId) {
  console.log(`[INFO] sendAppointmentFlow => phone=${userPhone}, org=${orgId}`);
  
  const orgConfig = await loadOrganizationConfig(orgId);
  if (!orgConfig) {
    console.error(`[ERROR] No configuration found for organization: ${orgId}`);
    return false;
  }

  const phoneId = orgConfig.whatsappPhoneId;
  const token = orgConfig.whatsappToken;
  const orgName = orgConfig.orgName;
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;

  const flowTok = generateFlowToken(6);

  let payload = {
    messaging_product: "whatsapp",
    to: userPhone,
    type: "interactive",
    interactive: {
      type: "flow",
      header: { type: "text", text: orgName },
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
    return resp.ok;
  } catch (e) {
    console.error("[ERROR] => sendAppointmentFlow:", e);
    return false;
  }
}

async function appointmentFlowImpl(action, userPhone, orgId) {
  console.log(`[INFO] appointmentFlowImpl => action=${action}, phone=${userPhone}, org=${orgId}`);
  switch (action) {
    case "new":
      await sendAppointmentFlow(userPhone, orgId);
      return "Appointment form sent.";
    case "reschedule":
      return "Rescheduling placeholder. Not implemented.";
    case "cancel":
      return "Cancellation placeholder. Not implemented.";
    default:
      return "Unknown appointment action => new, reschedule, cancel only.";
  }
}

async function createAppointmentDoc(pocRef, userPhone, flowData, orgId) {
  console.log(`[INFO] createAppointmentDoc => userPhone=${userPhone}, orgId=${orgId}`);
  let { flow_token, doctorId, date, time, reason, name, age, gender, specialty } = flowData || {};
  let patientName = name;

  let dateTs = null;
  if (date) {
    let d = new Date(date);
    if (!isNaN(d.getTime())) {
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
    createdAt: getCurrentIndianTime(),
    status: "Draft",
    date: date || "",
    dateTimestamp: dateTs || null,
    FlowToken: flow_token || "",
    OrgID: orgId,
  };

  let aptRef = orgRef.collection("Appointment").doc(aptId);
  await aptRef.set(aptDoc);
  console.log(`[INFO] Appointment => /Organisation/${orgId}/Appointment/${aptId} created at ${formatISTTimestamp()}`);

  const notificationMessage = `New appointment created for ${patientName} with ${doctorName} on ${date} at ${time}`;
  await createNotification(orgRef, userPhone, notificationMessage, "Appointment", {
    PoCRef: pocRef, 
    appointmentRef: aptRef,
    doctorRef: doctorRef
  });

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
    DOB: getCurrentIndianTime(),
    Gender: gender,
    Relation: newRelation,
    reason: reason || "",
    appointmentId: aptId,
    specialty: specialty || "",
    date: date || "",
    time: time || "",
    createdAt: getCurrentIndianTime(),
    OrgID: orgId,
  });
  console.log(
    `[INFO] New Patient doc added to PoC/${pocRef.id}/Patients => name="${patientName}" for org=${orgId} at ${formatISTTimestamp()}`
  );
}

// ----------------------------------------------------------------------
// Support flow - now organization-aware
// ----------------------------------------------------------------------
async function sendSupportTemplate(userPhone, orgId) {
  console.log(`[INFO] sendSupportTemplate => phone=${userPhone}, org=${orgId}`);
  
  const orgConfig = await loadOrganizationConfig(orgId);
  if (!orgConfig) {
    console.error(`[ERROR] No configuration found for organization: ${orgId}`);
    return false;
  }

  const phoneId = orgConfig.whatsappPhoneId;
  const token = orgConfig.whatsappToken;
  const orgName = orgConfig.orgName;
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
              text: orgName,
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
    return resp.ok;
  } catch (e) {
    console.error("[ERROR] => sendSupportTemplate:", e);
    return false;
  }
}

async function supportFlowImpl(department, userPhone, orgId) {
  console.log(`[INFO] supportFlowImpl => dept=${department}, userPhone=${userPhone}, org=${orgId}`);
  await sendSupportTemplate(userPhone, orgId);
  return "Support form sent.";
}

async function createSupportTicket(pocRef, userId, flowData, orgId) {
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
    createdAt: getCurrentIndianTime(),
    OrgID: orgId,
  };
  let ticketRef = orgRef.collection("Ticket").doc(ticketId);
  await ticketRef.set(doc);
  console.log(`[INFO] Created Ticket => /Organisation/${orgId}/Ticket/${ticketId} at ${formatISTTimestamp()}`);
  
  let pocSnap = await pocRef.get();
  let userPhone = pocSnap.exists && pocSnap.data().Phone ? pocSnap.data().Phone : "Unknown";
  let userName = pocSnap.exists && pocSnap.data().Name ? pocSnap.data().Name : "User";
  
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
// Checkin flow - now organization-aware
// ----------------------------------------------------------------------
async function createCheckinDoc(pocRef, userPhone, orgId) {
  console.log(`[INFO] createCheckinDoc => phone=${userPhone}, orgId=${orgId}`);
  const orgRef = await getOrganisationRef(orgId);
  if (!orgRef) {
    console.log(`[WARN] no Org doc for ${orgId} => cannot create checkin`);
    return;
  }
  
  let pocSnap = await pocRef.get();
  let pocData = pocSnap.exists ? pocSnap.data() : {};
  let userName = pocData.Name || "User";
  
  let checkinId = "CHK-" + generateId(8);
  let doc = {
    CheckinID: checkinId,
    PoCRef: pocRef,
    phone: userPhone,
    checkinTime: getCurrentIndianTime(),
    OrgID: orgId,
  };
  let checkinRef = orgRef.collection("Checkin").doc(checkinId);
  await checkinRef.set(doc);
  console.log(`[INFO] Created Checkin => /Organisation/${orgId}/Checkin/${checkinId} at ${formatISTTimestamp()}`);
  
  const notificationMessage = `${userName} just checked in at the facility`;
  await createNotification(orgRef, userPhone, notificationMessage, "Checkin", {
    PoCRef: pocRef,
    checkinRef: checkinRef
  });
}

// ----------------------------------------------------------------------
// Knowledge lookup - now organization-specific
// ----------------------------------------------------------------------
async function checkKnowledgeFullWithGpt(userQuery, fullKnowledgeText, orgConfig) {
  try {
    const content = `
You are ${orgConfig.orgName}'s helpful assistant. 
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
        { role: "system", content: `You are a helpful, human-like ${orgConfig.orgName} knowledge assistant.` },
        { role: "user", content }
      ],
      temperature: 0.5
    });
    let reply = completion.data.choices?.[0]?.message?.content?.trim() || "";
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

async function knowledgeLookupImpl(userQuery, orgId) {
  console.log(`[INFO] knowledgeLookupImpl => q="${userQuery}", org=${orgId} at ${formatISTTimestamp()}`);
  
  const knowledgeText = await loadKnowledgeBase(orgId);
  const orgConfig = await loadOrganizationConfig(orgId);
  
  if (!knowledgeText || knowledgeText.startsWith("Error") || knowledgeText.startsWith("No knowledge")) {
    return `No knowledge base loaded for ${orgConfig?.orgName || orgId}. Sorry.`;
  }

  const lcQuery = userQuery.toLowerCase();
  const lines = knowledgeText.split("\n");
  const matchingLines = lines.filter((line) => line.toLowerCase().includes(lcQuery));

  if (matchingLines.length > 0) {
    return await refineKnowledgeWithGpt(userQuery, matchingLines, orgConfig);
  }

  let fallbackReply = await checkKnowledgeFullWithGpt(userQuery, knowledgeText, orgConfig);
  if (fallbackReply && fallbackReply.trim().length > 0) {
    return fallbackReply;
  }

  return `No direct info found in the knowledge base. Please ask more about ${orgConfig?.orgName || orgId}!`;
}

async function refineKnowledgeWithGpt(userQuery, matchedLines, orgConfig) {
  try {
    const content = `
You are ${orgConfig.orgName}'s helpful assistant. 
The user asked: "${userQuery}"
We found these lines in the local knowledge database:

${matchedLines.join("\n")}

Please summarize them or craft a short, natural response. 
If the lines mention specific details, share them in a friendly tone.
`;
    let completion = await openai.createChatCompletion({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `You are a helpful, human-like ${orgConfig.orgName} knowledge assistant.` },
        { role: "user", content }
      ]
    });
    let choice = completion.data.choices[0];
    if (!choice) return matchedLines.join("\n");
    return choice.message.content || matchedLines.join("\n");
  } catch (err) {
    console.error("[ERROR] refineKnowledgeWithGpt =>", err);
    return matchedLines.join("\n");
  }
}

// ----------------------------------------------------------------------
// Small talk - now organization-aware
// ----------------------------------------------------------------------
function smallTalkImpl(userMessage, orgId, orgConfig) {
  console.log(`[INFO] smallTalkImpl => userMessage="${userMessage}", org=${orgId} at ${formatISTTimestamp()}`);
  const orgName = orgConfig?.orgName || orgId;
  return `Hello! ${orgName} is here to help. How can we assist you today?`;
}

// ----------------------------------------------------------------------
// Symptom assessment - now organization-specific
// ----------------------------------------------------------------------
async function symptomAssessmentImpl(userSymptom, orgId) {
  console.log(`[INFO] symptomAssessment => userSymptom=${userSymptom}, org=${orgId} at ${formatISTTimestamp()}`);

  let lines = userSymptom
    .split(/(\.|,|\n)/)
    .map((s) => s.trim())
    .filter((x) => x && x.length > 2);

  let resultParts = [];
  for (let line of lines) {
    let gptSpecialty = await classifySymptomWithGpt(line);
    let docList = await findDoctorsByFuzzySpecialty(gptSpecialty, orgId);

    let partialMsg = `*Symptom*: "${line}"\nLikely specialty: ${gptSpecialty}.\nDisclaimer: This is basic guidance, not a formal diagnosis. Please consult in person for serious concerns.`;
    if (docList && docList.length > 0) {
      partialMsg += `\n*Possible doctors* matching that specialty:`;
      for (let d of docList) {
        partialMsg += `\n*${d.Name}* (Specialization: ${d.Specialization.join(", ")})`;
      }
    } else {
      partialMsg += `\n[No specific doctor found for specialty "${gptSpecialty}" - kindly see a general physician.]`;
    }

    resultParts.push(partialMsg);
  }

  let finalCombined = resultParts.join("\n\n");
  finalCombined += `

Would you like to book an appointment with any of these doctors or ask more questions? 
If it feels severe, please see a physician immediately.`;

  return finalCombined;
}

async function classifySymptomWithGpt(symptomLine) {
  const POSSIBLE_SPECIALTIES = [
    "General Physician", "Neurologist", "Cardiologist", "Orthopedic Surgeon",
    "Pediatrician", "Gynecologist", "Pathologist", "Oncologist",
    "ENT Surgeon", "Gastroenterologist", "Neuro Physician",
    "General Surgeon", "Urologist", "Nephrologist", "Dermatologist",
    "Physiotherapist", "RMO", "Psychologist", "Anesthesiologist",
    "Allergist/Immunologist", "Endocrinologist", "Hematologist",
    "Infectious Disease Specialist", "Pulmonologist", "Radiologist",
    "Rheumatologist", "Psychiatrist", "Ophthalmologist", "Plastic Surgeon",
    "Vascular Surgeon", "Neonatologist", "Geriatrician",
    "Sports Medicine Specialist", "Emergency Medicine Physician",
    "Critical Care Specialist", "Family Medicine Physician",
    "Pain Management Specialist", "Occupational Health Physician",
    "Cardiothoracic Surgeon", "Neurosurgeon", "Hepatologist",
    "Colorectal Surgeon", "Obstetrician", "Andrologist",
    "Pediatric Surgeon", "Medical Geneticist", "Forensic Pathologist",
    "Maxillofacial Surgeon", "Transplant Surgeon", "Nuclear Medicine Physician",
    "Interventional Radiologist", "Palliative Care Specialist"
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

async function findDoctorsByFuzzySpecialty(specialty, orgId) {
  try {
    let snap = await db.collection("Doctors").where("OrgID", "==", orgId).get();
    if (snap.empty) {
      console.log(`[INFO] no doctors for organization ${orgId}`);
      return [];
    }
    let matchedDocs = [];
    let target = specialty.toLowerCase().trim().replace(/^['"]|['"]$/g, "");

    for (let doc of snap.docs) {
      let data = doc.data();
      let arr = data.Specialization || [];
      if (!Array.isArray(arr)) continue;

      let foundMatch = arr.some((spec) => {
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
// Utility functions
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
// Appointment feedback - now organization-aware
// ----------------------------------------------------------------------
async function updateAppointmentFeedback(flowData, orgId) {
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
    submittedAt: getCurrentIndianTime(),
  };

  await aptRef.update({ feedback });
  console.log(`[INFO] feedback updated => doc=${aptRef.id} at ${formatISTTimestamp()}`);
  
  const overallRating = overallExp !== "NA" ? `${overallExp}/5` : "N/A";
  const notificationMessage = `Feedback received for appointment with ${aptDoc.doctorName || "Unknown"}. Overall rating: ${overallRating}`;
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
// Function call handling - now organization-aware
// ----------------------------------------------------------------------
async function handleLocalFunctionCall(name, args, fromPhone, userId, userQuery, orgId) {
  console.log(`[INFO] handleLocalFunctionCall => name=${name}, orgId=${orgId} at ${formatISTTimestamp()}`);
  
  const orgConfig = await loadOrganizationConfig(orgId);
  
  switch (name) {
    case "appointment_flow":
      return appointmentFlowImpl(args.action, fromPhone, orgId);

    case "support_flow":
      return supportFlowImpl(args.department, fromPhone, orgId);

    case "knowledge_lookup":
      return await knowledgeLookupImpl(args.userQuery || "", orgId);

    case "small_talk":
      return smallTalkImpl(args.userMessage || "", orgId, orgConfig);

    case "symptom_assessment":
      return await symptomAssessmentImpl(args.userSymptom || "", orgId);

    default:
      return `Kindly only ask anything related to ${orgConfig?.orgName || orgId}.`;
  }
}

async function handleOpenAiFunctionCall(fCall, fromPhone, userId, userQuery, orgId) {
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
// System Prompt - now organization-aware
// ----------------------------------------------------------------------
function getSystemMessage(orgConfig) {
  return {
    role: "system",
    content: `
You are ${orgConfig.orgName}'s Chatbot in English. 
We've replaced the old knowledge lookup with substring search + 
a fallback GPT pass over the entire knowledge base if no substring found. 
We also use GPT for symptom classification. 
No other flows changed. 
Respond in a natural, friendly, and helpful manner representing ${orgConfig.orgName}.
`,
  };
}

// ----------------------------------------------------------------------
// Express App for the Cloud Function
// ----------------------------------------------------------------------
const app = express();
app.use(express.json());



app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  console.log(`[INFO] GET /webhook => mode=${mode}, token=${token} at ${formatISTTimestamp()}`);
  
  // For multi-tenant, we need to check which organization this verification is for
  // This could be enhanced to verify against organization-specific tokens
  if (mode && token) {
    if (mode === "subscribe") {
      // Accept any valid verification for now - in production, verify against org-specific tokens
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
    console.log(`[INFO] Processing webhook for organization: ${orgId}`);

    // Load organization configuration
    const orgConfig = await loadOrganizationConfig(orgId);
    if (!orgConfig) {
      console.error(`[ERROR] No configuration found for organization: ${orgId}`);
      return res.sendStatus(404);
    }

    // Check if organization is active
    if (!orgConfig.billingActive) {
      console.log(`[WARN] Organization ${orgId} is not active, ignoring webhook`);
      return res.sendStatus(200);
    }

    const entry = (req.body.entry && req.body.entry[0]) || {};
    const changes = (entry.changes && entry.changes[0]) || {};
    const value = changes.value || {};
    const msg = (value.messages && value.messages[0]) || null;

    // Get contact name
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
        orgConfig.whatsappPhoneId,
        "interactive",
        shortFlow
      );

      // Check if welcome registration form (contains Full Name field)
      if (flowData["screen_0_Full_Name_0"]) {
        console.log(`[INFO] Processing welcome form submission from ${fromUser} at ${formatISTTimestamp()}`);
        await processWelcomeFormSubmission(pocRef, flowData, orgId);
        let welcomeMsg = "Thank you for completing your registration! You can now use our services.";
        await sendWhatsAppMessage(fromUser, welcomeMsg, orgId);
        await saveChatToPoC(
          pocRef,
          "outbound",
          orgConfig.whatsappPhoneId,
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
        await sendWhatsAppMessage(fromUser, finalMsg, orgId);
        await saveChatToPoC(
          pocRef,
          "outbound",
          orgConfig.whatsappPhoneId,
          fromUser,
          "text",
          finalMsg
        );
      }
      else if (flowData["screen_0_Description_of_issue_2"]) {
        // => support
        await createSupportTicket(pocRef, pocRef.id, flowData, orgId);
        let finalMsg = "We have created your support ticket. Thank you!";
        await sendWhatsAppMessage(fromUser, finalMsg, orgId);
        await saveChatToPoC(
          pocRef,
          "outbound",
          orgConfig.whatsappPhoneId,
          fromUser,
          "text",
          finalMsg
        );
      } else {
        // assume appointment
        await createAppointmentDoc(pocRef, fromUser, flowData, orgId);
        let ack = "Your appointment has been recorded. Thank you!";
        await sendWhatsAppMessage(fromUser, ack, orgId);
        await saveChatToPoC(
          pocRef,
          "outbound",
          orgConfig.whatsappPhoneId,
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

        let publicUrl = await downloadWhatsAppMediaAndUpload(mediaId, mimeType, orgId);
        if (!publicUrl) {
          publicUrl = "Failed to retrieve media from WA.";
        }

        // store chat with public link
        if (msg.type === "image") {
          await saveChatToPoC(
            pocRef,
            "inbound",
            from,
            orgConfig.whatsappPhoneId,
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
            orgConfig.whatsappPhoneId,
            extension,
            publicUrl
          );
        } else if (msg.type === "video") {
          await saveChatToPoC(
            pocRef,
            "inbound",
            from,
            orgConfig.whatsappPhoneId,
            "video",
            publicUrl
          );
        } else if (msg.type === "audio") {
          await saveChatToPoC(
            pocRef,
            "inbound",
            from,
            orgConfig.whatsappPhoneId,
            "audio",
            publicUrl
          );
        }
        
        // Create notification for media message
        const orgRef = await getOrganisationRef(orgId);
        if (orgRef) {
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
        await saveChatToPoC(pocRef, "inbound", from, orgConfig.whatsappPhoneId, "text", userText);
        
        // Create notification for new message if it's not a special command and has meaningful content
        if (!userText.startsWith("Checkin:") && userText.length > 10) {
          const orgRef = await getOrganisationRef(orgId);
          if (orgRef) {
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

        // "Checkin:OrgID" => create doc
        if (userText.startsWith("Checkin:")) {
          let checkVal = userText.split(":")[1] || "";
          if (checkVal.trim() === orgId) {
            await createCheckinDoc(pocRef, from, orgId);
            let checkAck = `Welcome to ${orgConfig.orgName}! Check-in recorded. Please proceed!`;
            await sendWhatsAppMessage(from, checkAck, orgId);
            await saveChatToPoC(
              pocRef,
              "outbound",
              orgConfig.whatsappPhoneId,
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
        
        const systemMessage = getSystemMessage(orgConfig);
        if (!messages.find((m) => m.role === "system")) {
          messages.unshift(systemMessage);
        }
        messages.push({ role: "user", content: userText });

        console.log(`[INFO] calling openai => function_call=auto for org=${orgId} at ${formatISTTimestamp()}`);
        const openAiTools = getOpenAiTools(orgId);
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

        await sendWhatsAppMessage(from, finalReply, orgId);
        await saveChatToPoC(
          pocRef,
          "outbound",
          orgConfig.whatsappPhoneId,
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

// ----------------------------------------------------------------------
// Multi-tenant Administration Endpoints
// ----------------------------------------------------------------------

// Endpoint to refresh organization configurations
app.post("/refresh-org-config", async (req, res) => {
  try {
    const secret = req.query.secret;
    const orgId = req.query.orgId;
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    if (orgId) {
      // Refresh specific organization
      const config = await refreshOrganizationConfig(orgId);
      if (!config) {
        return res.status(404).json({ error: `Organization ${orgId} not found` });
      }
      return res.status(200).json({ 
        success: true, 
        message: `Configuration refreshed for ${orgId}`,
        config: config,
        timestamp: formatISTTimestamp()
      });
    } else {
      // Clear entire cache
      organizationConfigs.clear();
      knowledgeCache.clear();
      return res.status(200).json({ 
        success: true, 
        message: "All organization configurations cleared",
        timestamp: formatISTTimestamp()
      });
    }
  } catch (e) {
    console.error(`[ERROR] refresh-org-config failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Endpoint to list all organizations
app.get("/organizations", async (req, res) => {
  try {
    const secret = req.query.secret;
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    const organizations = await getAllActiveOrganizations();
    return res.status(200).json({
      success: true,
      count: organizations.length,
      organizations,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] organizations endpoint failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Enhanced migration endpoint for multi-tenant
app.get("/migrate-pocs", async (req, res) => {
  try {
    console.log(`[INFO] Running migration at ${formatISTTimestamp()}`);
    const secret = req.query.secret;
    const targetOrgId = req.query.orgId || "Saijyot";
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    const batch = db.batch();
    
    // Find records without addedBy field
    const snapshot1 = await db.collection("PoC").where("addedBy", "==", null).get();
    
    let count1 = 0;
    snapshot1.docs.forEach(doc => {
      batch.update(doc.ref, { 
        addedBy: targetOrgId,
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
        batch.update(doc.ref, { registered: true });
        count3++;
      }
    });
    
    if (count1 + count2 + count3 > 0) {
      await batch.commit();
    }
    
    return res.status(200).json({ 
      success: true, 
      message: `Updated ${count1} PoCs with addedBy="${targetOrgId}", ${count2} with lastSeen, and ${count3} with registered=true`,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] migration failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Enhanced PoC lookup across organizations
app.get("/pocs-by-phone", async (req, res) => {
  try {
    const secret = req.query.secret;
    const phone = req.query.phone;
    const orgId = req.query.orgId;
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    if (!phone) {
      return res.status(400).json({ error: "Phone number required" });
    }
    
    let results;
    if (orgId) {
      // Search within specific organization
      const snap = await db
        .collection("PoC")
        .where("Phone", "==", phone)
        .where("addedBy", "==", orgId)
        .get();
      
      results = snap.docs.map(doc => ({
        id: doc.id,
        organization: doc.data().addedBy || "Unknown",
        lastSeen: doc.data().lastSeen ? doc.data().lastSeen.toDate().toISOString() : null,
        registered: doc.data().registered === true ? "Yes" : "No",
        ...doc.data()
      }));
    } else {
      // Search across all organizations
      results = await findPoCsAcrossOrganizations(phone);
    }
    
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

// Enhanced welcome template sending
app.get("/send-welcome", async (req, res) => {
  try {
    const secret = req.query.secret;
    const phone = req.query.phone;
    const orgId = req.query.orgId || "Saijyot";
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    if (!phone) {
      return res.status(400).json({ error: "Phone number required" });
    }
    
    // Check if organization exists and is active
    const orgConfig = await loadOrganizationConfig(orgId);
    if (!orgConfig) {
      return res.status(404).json({ error: `Organization ${orgId} not found` });
    }
    
    if (!orgConfig.billingActive) {
      return res.status(400).json({ error: `Organization ${orgId} is not active` });
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
    
    // Send welcome template
    const success = await sendWelcomeTemplate(phone, pocName, orgId);
    
    return res.status(200).json({
      success: success,
      message: success ? `Welcome template sent to ${phone}` : `Failed to send welcome template to ${phone}`,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] send-welcome failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Enhanced registration status checking
app.get("/check-registration", async (req, res) => {
  try {
    const secret = req.query.secret;
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    const orgId = req.query.orgId;
    
    if (orgId) {
      // Check specific organization
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
            organization: data.addedBy,
            createdAt: data.Created_Timestamp ? data.Created_Timestamp.toDate().toISOString() : null
          });
        }
      });
      
      return res.status(200).json({
        success: true,
        organization: orgId,
        registered,
        unregistered,
        unregisteredPocs,
        timestamp: formatISTTimestamp()
      });
    } else {
      // Check all organizations
      const allOrgs = await getAllActiveOrganizations();
      const results = {};
      
      for (const org of allOrgs) {
        const pocsSnap = await db
          .collection("PoC")
          .where("addedBy", "==", org.OrgID)
          .get();
        
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
        
        results[org.OrgID] = {
          orgName: org.Name,
          registered,
          unregistered,
          unregisteredPocs
        };
      }
      
      return res.status(200).json({
        success: true,
        allOrganizations: results,
        timestamp: formatISTTimestamp()
      });
    }
  } catch (e) {
    console.error(`[ERROR] check-registration failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Enhanced notifications endpoint
app.get("/notifications", async (req, res) => {
  try {
    const secret = req.query.secret;
    const orgId = req.query.orgId || "Saijyot";
    const limit = parseInt(req.query.limit || "20", 10);
    const eventType = req.query.eventType || null;
    const unseenOnly = req.query.unseenOnly === 'true';
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    // Check if organization exists
    const orgConfig = await loadOrganizationConfig(orgId);
    if (!orgConfig) {
      return res.status(404).json({ error: `Organization ${orgId} not found` });
    }
    
    const orgRef = await getOrganisationRef(orgId);
    if (!orgRef) {
      return res.status(404).json({ error: `Organization ${orgId} not found` });
    }
    
    let notificationsQuery = orgRef.collection("Notifications")
                               .orderBy("timestamp", "desc");
    
    if (eventType) {
      notificationsQuery = notificationsQuery.where("event", "==", eventType);
    }
    
    if (unseenOnly) {
      notificationsQuery = notificationsQuery.where("seen", "==", false);
    }
    
    notificationsQuery = notificationsQuery.limit(limit);
    
    const notificationsSnap = await notificationsQuery.get();
    
    const notifications = notificationsSnap.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        from: data.from,
        message: data.message,
        timestamp: data.timestamp ? data.timestamp.toDate().toISOString() : null,
        seen: data.seen === true,
        event: data.event,
        organization: orgId,
        ...Object.fromEntries(
          Object.entries(data)
            .filter(([key]) => !['from', 'message', 'timestamp', 'seen', 'event'].includes(key))
        )
      };
    });
    
    return res.status(200).json({
      success: true,
      organization: orgId,
      count: notifications.length,
      notifications,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] get-notifications failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Enhanced mark notifications as seen
app.post("/notifications/mark-seen", async (req, res) => {
  try {
    const secret = req.query.secret;
    const orgId = req.query.orgId || "Saijyot";
    const notificationIds = req.body.notificationIds || [];
    const markAll = req.body.markAll === true;
    
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
      organization: orgId,
      message: markAll ? `Marked all ${count} unseen notifications as seen` : `Marked ${count} notifications as seen`,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] mark-notifications-seen failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Enhanced notification counts
app.get("/notification-counts", async (req, res) => {
  try {
    const secret = req.query.secret;
    const orgId = req.query.orgId;
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    if (orgId) {
      // Get counts for specific organization
      const orgRef = await getOrganisationRef(orgId);
      if (!orgRef) {
        return res.status(404).json({ error: `Organization ${orgId} not found` });
      }
      
      const notificationsSnap = await orgRef.collection("Notifications").get();
      
      const counts = {
        organization: orgId,
        total: notificationsSnap.size,
        unseen: 0,
        byEventType: {},
        unseenByEventType: {}
      };
      
      notificationsSnap.docs.forEach(doc => {
        const data = doc.data();
        const eventType = data.event || 'Unknown';
        const seen = data.seen === true;
        
        if (!counts.byEventType[eventType]) {
          counts.byEventType[eventType] = 0;
        }
        if (!counts.unseenByEventType[eventType]) {
          counts.unseenByEventType[eventType] = 0;
        }
        
        counts.byEventType[eventType]++;
        
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
    } else {
      // Get counts for all organizations
      const allOrgs = await getAllActiveOrganizations();
      const allCounts = {};
      
      for (const org of allOrgs) {
        const orgRef = await getOrganisationRef(org.OrgID);
        if (!orgRef) continue;
        
        const notificationsSnap = await orgRef.collection("Notifications").get();
        
        const counts = {
          orgName: org.Name,
          total: notificationsSnap.size,
          unseen: 0,
          byEventType: {},
          unseenByEventType: {}
        };
        
        notificationsSnap.docs.forEach(doc => {
          const data = doc.data();
          const eventType = data.event || 'Unknown';
          const seen = data.seen === true;
          
          if (!counts.byEventType[eventType]) {
            counts.byEventType[eventType] = 0;
          }
          if (!counts.unseenByEventType[eventType]) {
            counts.unseenByEventType[eventType] = 0;
          }
          
          counts.byEventType[eventType]++;
          
          if (!seen) {
            counts.unseen++;
            counts.unseenByEventType[eventType]++;
          }
        });
        
        allCounts[org.OrgID] = counts;
      }
      
      return res.status(200).json({
        success: true,
        allOrganizations: allCounts,
        timestamp: formatISTTimestamp()
      });
    }
  } catch (e) {
    console.error(`[ERROR] notification-counts failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Organization configuration testing endpoint
app.get("/test-org-config", async (req, res) => {
  try {
    const secret = req.query.secret;
    const orgId = req.query.orgId;
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    if (!orgId) {
      return res.status(400).json({ error: "Organization ID required" });
    }
    
    const orgConfig = await loadOrganizationConfig(orgId);
    if (!orgConfig) {
      return res.status(404).json({ error: `Organization ${orgId} not found` });
    }
    
    // Test configuration completeness
    const tests = {
      organizationExists: !!orgConfig,
      hasWhatsAppToken: !!orgConfig.whatsappToken,
      hasWhatsAppPhoneId: !!orgConfig.whatsappPhoneId,
      isActive: orgConfig.billingActive,
      hasKnowledgeBase: false
    };
    
    // Test knowledge base
    try {
      const knowledge = await loadKnowledgeBase(orgId);
      tests.hasKnowledgeBase = knowledge && !knowledge.startsWith("No knowledge") && !knowledge.startsWith("Error");
    } catch (e) {
      tests.knowledgeBaseError = e.message;
    }
    
    // Test WhatsApp API connectivity (optional)
    if (tests.hasWhatsAppToken && tests.hasWhatsAppPhoneId) {
      try {
        const testUrl = `https://graph.facebook.com/v17.0/${orgConfig.whatsappPhoneId}`;
        const testResponse = await fetch(testUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${orgConfig.whatsappToken}` }
        });
        tests.whatsappApiConnectivity = testResponse.ok;
        tests.whatsappApiStatus = testResponse.status;
      } catch (e) {
        tests.whatsappApiError = e.message;
      }
    }
    
    const allTestsPassed = tests.organizationExists && 
                          tests.hasWhatsAppToken && 
                          tests.hasWhatsAppPhoneId && 
                          tests.isActive;
    
    return res.status(200).json({
      success: true,
      organization: orgId,
      config: {
        orgName: orgConfig.orgName,
        billingActive: orgConfig.billingActive,
        billingPlan: orgConfig.billingPlan,
        hasToken: !!orgConfig.whatsappToken,
        hasPhoneId: !!orgConfig.whatsappPhoneId
      },
      tests,
      allTestsPassed,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] test-org-config failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Health check endpoint with multi-tenant status
app.get("/", (req, res) => {
  res.status(200).json({
    message: "Multi-tenant HRM Bot is running!",
    version: "2.0.0-multitenant",
    features: [
      "Multi-organization support",
      "Organization-specific WhatsApp credentials",
      "Organization-specific knowledge bases",
      "Cross-organization PoC lookup",
      "Enhanced notification system"
    ],
    timestamp: formatISTTimestamp(),
    timezone: "IST (UTC+5:30)",
    cachedOrganizations: organizationConfigs.size,
    cachedKnowledgeBases: knowledgeCache.size
  });
});

// Development helper endpoint to clear caches
app.post("/clear-cache", async (req, res) => {
  try {
    const secret = req.query.secret;
    
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    const cacheType = req.query.type || "all";
    
    if (cacheType === "all" || cacheType === "org") {
      organizationConfigs.clear();
    }
    
    if (cacheType === "all" || cacheType === "knowledge") {
      knowledgeCache.clear();
    }
    
    return res.status(200).json({
      success: true,
      message: `Cleared ${cacheType} cache(s)`,
      timestamp: formatISTTimestamp()
    });
  } catch (e) {
    console.error(`[ERROR] clear-cache failed => ${e} at ${formatISTTimestamp()}`);
    return res.status(500).json({ error: e.message });
  }
});

// Register the Express app as a Cloud Function
functions.http('HRM', app);

module.exports = app;
