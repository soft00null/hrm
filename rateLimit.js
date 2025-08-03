/**
 * Simple rate limiting middleware for HRM Bot
 * Implements in-memory rate limiting with cleanup
 */

const { RATE_LIMITS, ERROR_MESSAGES } = require('./constants');

// In-memory store for rate limiting (in production, consider Redis)
const rateLimitStore = new Map();

/**
 * Cleans up old entries from rate limit store
 */
function cleanupOldEntries() {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now - data.windowStart > RATE_LIMITS.WINDOW_MS) {
      rateLimitStore.delete(key);
    }
  }
}

/**
 * Gets or creates rate limit data for a key
 * @param {string} key - Rate limit key (usually IP or phone number)
 * @returns {Object} Rate limit data
 */
function getRateLimitData(key) {
  const now = Date.now();
  let data = rateLimitStore.get(key);
  
  if (!data || now - data.windowStart > RATE_LIMITS.WINDOW_MS) {
    data = {
      count: 0,
      windowStart: now
    };
    rateLimitStore.set(key, data);
  }
  
  return data;
}

/**
 * Creates a rate limiter middleware
 * @param {Object} options - Rate limiting options
 * @param {number} options.max - Maximum requests per window
 * @param {number} options.windowMs - Window size in milliseconds
 * @param {Function} options.keyGenerator - Function to generate rate limit key
 * @returns {Function} Express middleware
 */
function createRateLimit(options = {}) {
  const {
    max = RATE_LIMITS.MAX_REQUESTS,
    windowMs = RATE_LIMITS.WINDOW_MS,
    keyGenerator = (req) => req.ip || 'unknown'
  } = options;
  
  return (req, res, next) => {
    try {
      const key = keyGenerator(req);
      const data = getRateLimitData(key);
      
      data.count++;
      
      // Add rate limit headers
      res.set({
        'X-RateLimit-Limit': max,
        'X-RateLimit-Remaining': Math.max(0, max - data.count),
        'X-RateLimit-Reset': new Date(data.windowStart + windowMs).toISOString()
      });
      
      if (data.count > max) {
        console.warn(`[WARN] Rate limit exceeded for key: ${key}, count: ${data.count}`);
        return res.status(429).json({
          error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
          retryAfter: Math.ceil((data.windowStart + windowMs - Date.now()) / 1000)
        });
      }
      
      next();
    } catch (error) {
      console.error('[ERROR] Rate limiting failed:', error);
      // Don't block requests if rate limiting fails
      next();
    }
  };
}

/**
 * Rate limiter for webhook endpoints
 * Uses phone number as key when available, fallback to IP
 */
const webhookRateLimit = createRateLimit({
  max: RATE_LIMITS.WEBHOOK_MAX_REQUESTS,
  keyGenerator: (req) => {
    // Try to get phone number from WhatsApp webhook
    try {
      if (req.body && req.body.entry && req.body.entry[0]) {
        const changes = req.body.entry[0].changes;
        if (changes && changes[0] && changes[0].value && changes[0].value.messages) {
          const messages = changes[0].value.messages;
          if (messages[0] && messages[0].from) {
            return `phone:${messages[0].from}`;
          }
        }
      }
    } catch (e) {
      // Fallback to IP-based rate limiting
    }
    
    return `ip:${req.ip || 'unknown'}`;
  }
});

/**
 * General rate limiter for all endpoints
 */
const generalRateLimit = createRateLimit({
  max: RATE_LIMITS.MAX_REQUESTS,
  keyGenerator: (req) => `ip:${req.ip || 'unknown'}`
});

// Cleanup old entries every 5 minutes
setInterval(cleanupOldEntries, 5 * 60 * 1000);

module.exports = {
  createRateLimit,
  webhookRateLimit,
  generalRateLimit,
  cleanupOldEntries,
};