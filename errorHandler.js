/**
 * Error handling middleware and utilities for HRM Bot
 * Provides centralized error handling and logging
 */

const { ERROR_MESSAGES } = require('./constants');

/**
 * Centralized error logger
 * @param {Error} error - Error object
 * @param {string} context - Context where error occurred
 * @param {Object} metadata - Additional metadata about the error
 */
function logError(error, context = 'Unknown', metadata = {}) {
  const timestamp = new Date().toISOString();
  const errorInfo = {
    timestamp,
    context,
    message: error.message,
    stack: error.stack,
    metadata
  };
  
  console.error(`[ERROR] ${context}:`, errorInfo);
  
  // In production, you might want to send this to a logging service
  // e.g., Google Cloud Logging, Datadog, etc.
}

/**
 * Async wrapper that catches errors and passes them to error handler
 * @param {Function} fn - Async function to wrap
 * @returns {Function} Wrapped function
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Express error handling middleware
 * Should be the last middleware in the chain
 */
function errorHandler(err, req, res, next) {
  // Log the error
  logError(err, `${req.method} ${req.path}`, {
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    body: req.body
  });
  
  // Don't expose error details in production
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  // Default error response
  let statusCode = 500;
  let message = ERROR_MESSAGES.INTERNAL_ERROR;
  
  // Handle specific error types
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = ERROR_MESSAGES.INVALID_INPUT;
  } else if (err.name === 'UnauthorizedError') {
    statusCode = 401;
    message = ERROR_MESSAGES.AUTHENTICATION_FAILED;
  } else if (err.status) {
    statusCode = err.status;
  }
  
  const response = {
    error: message,
    timestamp: new Date().toISOString()
  };
  
  // Include error details in development
  if (isDevelopment) {
    response.details = err.message;
    response.stack = err.stack;
  }
  
  res.status(statusCode).json(response);
}

/**
 * Handles unhandled promise rejections
 */
function handleUnhandledRejection() {
  process.on('unhandledRejection', (reason, promise) => {
    logError(new Error(reason), 'UnhandledRejection', { promise });
    // Don't exit the process in production, but log it
    console.error('[CRITICAL] Unhandled Promise Rejection detected');
  });
}

/**
 * Handles uncaught exceptions
 */
function handleUncaughtException() {
  process.on('uncaughtException', (error) => {
    logError(error, 'UncaughtException');
    console.error('[CRITICAL] Uncaught Exception detected');
    // In production, you might want to gracefully shutdown
    // process.exit(1);
  });
}

/**
 * Safe database operation wrapper
 * @param {Function} operation - Database operation function
 * @param {string} operationName - Name of the operation for logging
 * @returns {Promise} Result of the operation or null if failed
 */
async function safeDbOperation(operation, operationName = 'Database Operation') {
  try {
    return await operation();
  } catch (error) {
    logError(error, operationName);
    return null;
  }
}

/**
 * Safe API call wrapper with retry logic
 * @param {Function} apiCall - API call function
 * @param {string} callName - Name of the API call for logging
 * @param {number} maxRetries - Maximum number of retries
 * @returns {Promise} Result of the API call or null if failed
 */
async function safeApiCall(apiCall, callName = 'API Call', maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      logError(error, `${callName} (Attempt ${attempt})`);
      
      if (attempt === maxRetries) {
        return null;
      }
      
      // Exponential backoff
      const delay = Math.pow(2, attempt) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Validates and handles errors for WhatsApp API responses
 * @param {Object} response - API response object
 * @param {string} operation - Operation name for logging
 * @returns {boolean} True if response is valid
 */
function validateWhatsAppResponse(response, operation = 'WhatsApp API') {
  if (!response.ok) {
    logError(new Error(`${operation} failed with status ${response.status}`), operation);
    return false;
  }
  return true;
}

// Setup global error handlers
handleUnhandledRejection();
handleUncaughtException();

module.exports = {
  logError,
  asyncHandler,
  errorHandler,
  safeDbOperation,
  safeApiCall,
  validateWhatsAppResponse,
};