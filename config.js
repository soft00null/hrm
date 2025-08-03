/**
 * Configuration management for HRM Bot
 * Handles environment variables and configuration validation
 */

const CONFIG = {
  // WhatsApp Configuration
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
  WHATSAPP_PHONE_ID: process.env.WHATSAPP_PHONE_ID || '',
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || '',
  
  // OpenAI Configuration
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  
  // Firebase Configuration
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || 'connectcare-hrm.firebasestorage.app',
  
  // Server Configuration
  PORT: parseInt(process.env.PORT) || 8080,
  NODE_ENV: process.env.NODE_ENV || 'development',
  
  // Rate Limiting
  ENABLE_RATE_LIMITING: process.env.ENABLE_RATE_LIMITING !== 'false',
  
  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  
  // Knowledge Base
  KNOWLEDGE_BASE_URL: process.env.KNOWLEDGE_BASE_URL || 'https://Testhospital.in/',
};

/**
 * Validates required configuration values
 * @returns {Array} Array of missing configuration keys
 */
function validateConfig() {
  const required = [
    'WHATSAPP_TOKEN',
    'WHATSAPP_PHONE_ID', 
    'VERIFY_TOKEN',
    'OPENAI_API_KEY'
  ];
  
  const missing = required.filter(key => !CONFIG[key]);
  return missing;
}

/**
 * Logs configuration status (without exposing sensitive values)
 */
function logConfigStatus() {
  const missing = validateConfig();
  
  if (missing.length > 0) {
    console.warn('[WARN] Missing configuration values:', missing);
    console.warn('[WARN] System may not function properly without these values');
  } else {
    console.log('[INFO] All required configuration values are present');
  }
  
  console.log(`[INFO] Environment: ${CONFIG.NODE_ENV}`);
  console.log(`[INFO] Port: ${CONFIG.PORT}`);
  console.log(`[INFO] Rate limiting: ${CONFIG.ENABLE_RATE_LIMITING ? 'enabled' : 'disabled'}`);
}

module.exports = {
  CONFIG,
  validateConfig,
  logConfigStatus,
};