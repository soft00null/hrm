/**
 * Utility functions for HRM Bot
 * Common helper functions extracted from main application
 */

const { MESSAGE_CONFIG } = require('./constants');

/**
 * Generates a random ID string
 * @param {number} length - Length of the ID (default from config)
 * @returns {string} Random ID string
 */
function generateId(length = MESSAGE_CONFIG.ID_LENGTH) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generates a random flow token (numeric)
 * @param {number} length - Length of the token (default from config)
 * @returns {string} Random numeric token
 */
function generateFlowToken(length = MESSAGE_CONFIG.FLOW_TOKEN_LENGTH) {
  const digits = "0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += digits.charAt(Math.floor(Math.random() * digits.length));
  }
  return result;
}

/**
 * Formats a timestamp for display
 * @param {Date|number} timestamp - Timestamp to format
 * @returns {string} Formatted timestamp
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toISOString();
}

/**
 * Truncates text to a specified length with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 */
function truncateText(text, maxLength = MESSAGE_CONFIG.TRUNCATED_MESSAGE_LENGTH) {
  if (!text || typeof text !== 'string') return '';
  
  if (text.length <= maxLength) return text;
  
  return text.slice(0, maxLength) + "...(truncated)";
}

/**
 * Extracts file extension from MIME type
 * @param {string} mimeType - MIME type string
 * @returns {string} File extension
 */
function getFileExtensionFromMimeType(mimeType) {
  if (!mimeType || typeof mimeType !== 'string') return 'dat';
  
  if (mimeType.includes("image")) {
    return mimeType.split("/")[1] || 'img';
  } else if (mimeType.includes("pdf")) {
    return "pdf";
  } else if (mimeType.includes("audio")) {
    return "audio";
  } else if (mimeType.includes("video")) {
    return "video";
  }
  
  return 'dat';
}

/**
 * Delays execution for specified milliseconds
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} Promise that resolves after delay
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculates exponential backoff delay
 * @param {number} attempt - Current attempt number (1-based)
 * @param {number} baseDelay - Base delay in milliseconds
 * @returns {number} Calculated delay in milliseconds
 */
function calculateBackoffDelay(attempt, baseDelay = 1000) {
  return Math.min(Math.pow(2, attempt) * baseDelay, 30000); // Max 30 seconds
}

/**
 * Safely parses JSON string
 * @param {string} jsonString - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails
 * @returns {*} Parsed object or default value
 */
function safeJsonParse(jsonString, defaultValue = null) {
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    return defaultValue;
  }
}

/**
 * Checks if a value is empty (null, undefined, empty string, empty array)
 * @param {*} value - Value to check
 * @returns {boolean} True if empty
 */
function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === 'object' && Object.keys(value).length === 0) return true;
  
  return false;
}

/**
 * Normalizes phone number format
 * @param {string} phone - Phone number to normalize
 * @returns {string} Normalized phone number
 */
function normalizePhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return '';
  
  // Remove all non-digit characters except +
  let normalized = phone.replace(/[^\d+]/g, '');
  
  // Ensure it starts with + if it doesn't already
  if (!normalized.startsWith('+') && normalized.length > 0) {
    normalized = '+' + normalized;
  }
  
  return normalized;
}

/**
 * Creates a simple cache with TTL support
 * @param {number} ttlMs - Time to live in milliseconds
 * @returns {Object} Cache object with get, set, and clear methods
 */
function createSimpleCache(ttlMs = 60000) {
  const cache = new Map();
  
  return {
    get(key) {
      const item = cache.get(key);
      if (!item) return null;
      
      if (Date.now() > item.expiry) {
        cache.delete(key);
        return null;
      }
      
      return item.value;
    },
    
    set(key, value) {
      cache.set(key, {
        value,
        expiry: Date.now() + ttlMs
      });
    },
    
    clear() {
      cache.clear();
    },
    
    size() {
      return cache.size;
    }
  };
}

module.exports = {
  generateId,
  generateFlowToken,
  formatTimestamp,
  truncateText,
  getFileExtensionFromMimeType,
  delay,
  calculateBackoffDelay,
  safeJsonParse,
  isEmpty,
  normalizePhoneNumber,
  createSimpleCache,
};