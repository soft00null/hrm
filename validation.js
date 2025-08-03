/**
 * Input validation middleware for HRM Bot
 * Provides basic validation and sanitization for incoming requests
 */

const { ERROR_MESSAGES } = require('./constants');

/**
 * Sanitizes text input by removing potentially harmful characters
 * @param {string} text - Input text to sanitize
 * @returns {string} Sanitized text
 */
function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  
  return text
    .replace(/[<>]/g, '') // Remove < and > to prevent basic XSS
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .trim()
    .slice(0, 4096); // Limit length
}

/**
 * Validates phone number format
 * @param {string} phone - Phone number to validate
 * @returns {boolean} True if valid format
 */
function isValidPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return false;
  
  // Basic international phone number validation
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  return phoneRegex.test(phone.replace(/\s+/g, ''));
}

/**
 * Validates webhook signature (basic check)
 * @param {string} signature - Webhook signature
 * @returns {boolean} True if signature format is valid
 */
function isValidSignature(signature) {
  if (!signature || typeof signature !== 'string') return false;
  
  // Basic signature format check
  return signature.startsWith('sha256=') && signature.length > 10;
}

/**
 * Validates WhatsApp message structure
 * @param {Object} message - WhatsApp message object
 * @returns {Object} Validation result with isValid and errors
 */
function validateWhatsAppMessage(message) {
  const errors = [];
  
  if (!message || typeof message !== 'object') {
    errors.push('Invalid message format');
    return { isValid: false, errors };
  }
  
  // Check required fields
  if (!message.from || !isValidPhoneNumber(message.from)) {
    errors.push('Invalid or missing sender phone number');
  }
  
  if (!message.id || typeof message.id !== 'string') {
    errors.push('Invalid or missing message ID');
  }
  
  if (!message.timestamp || isNaN(parseInt(message.timestamp))) {
    errors.push('Invalid or missing timestamp');
  }
  
  // Validate message type and content
  if (message.text && typeof message.text !== 'object') {
    errors.push('Invalid text message format');
  }
  
  if (message.image && typeof message.image !== 'object') {
    errors.push('Invalid image message format');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Express middleware for validating webhook requests
 */
function validateWebhookRequest(req, res, next) {
  try {
    // Validate content type
    if (req.method === 'POST' && !req.is('application/json')) {
      return res.status(400).json({ 
        error: ERROR_MESSAGES.INVALID_INPUT,
        details: 'Content-Type must be application/json'
      });
    }
    
    // For POST requests, validate the body structure
    if (req.method === 'POST' && req.body) {
      const { entry } = req.body;
      
      if (!Array.isArray(entry)) {
        return res.status(400).json({ 
          error: ERROR_MESSAGES.INVALID_INPUT,
          details: 'Invalid webhook entry format'
        });
      }
      
      // Validate each entry
      for (const entryItem of entry) {
        if (!entryItem.changes || !Array.isArray(entryItem.changes)) {
          return res.status(400).json({ 
            error: ERROR_MESSAGES.INVALID_INPUT,
            details: 'Invalid webhook changes format'
          });
        }
      }
    }
    
    next();
  } catch (error) {
    console.error('[ERROR] Webhook validation failed:', error);
    return res.status(400).json({ 
      error: ERROR_MESSAGES.INVALID_INPUT,
      details: 'Webhook validation failed'
    });
  }
}

/**
 * Express middleware for basic request sanitization
 */
function sanitizeRequest(req, res, next) {
  try {
    // Sanitize query parameters
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === 'string') {
          req.query[key] = sanitizeText(value);
        }
      }
    }
    
    // Sanitize body text fields (recursive)
    if (req.body && typeof req.body === 'object') {
      sanitizeObjectTextFields(req.body);
    }
    
    next();
  } catch (error) {
    console.error('[ERROR] Request sanitization failed:', error);
    return res.status(400).json({ 
      error: ERROR_MESSAGES.INVALID_INPUT,
      details: 'Request sanitization failed'
    });
  }
}

/**
 * Recursively sanitizes text fields in an object
 * @param {Object} obj - Object to sanitize
 */
function sanitizeObjectTextFields(obj) {
  if (!obj || typeof obj !== 'object') return;
  
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      obj[key] = sanitizeText(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitizeObjectTextFields(value);
    }
  }
}

module.exports = {
  sanitizeText,
  isValidPhoneNumber,
  isValidSignature,
  validateWhatsAppMessage,
  validateWebhookRequest,
  sanitizeRequest,
};