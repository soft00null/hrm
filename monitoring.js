/**
 * Simple monitoring and metrics collection for HRM Bot
 * Tracks basic application metrics for performance monitoring
 */

/**
 * Simple metrics collector
 */
class MetricsCollector {
  constructor() {
    this.metrics = {
      requests: {
        total: 0,
        webhook: 0,
        health: 0,
      },
      responses: {
        success: 0,
        error: 0,
        rateLimited: 0,
      },
      cache: {
        hits: 0,
        misses: 0,
      },
      whatsapp: {
        messagesSent: 0,
        messagesReceived: 0,
        sendErrors: 0,
      },
      database: {
        operations: 0,
        errors: 0,
      },
      uptime: Date.now(),
    };
  }

  /**
   * Increment a metric counter
   * @param {string} category - Metric category
   * @param {string} name - Metric name
   * @param {number} value - Value to add (default: 1)
   */
  increment(category, name, value = 1) {
    if (this.metrics[category] && typeof this.metrics[category][name] === 'number') {
      this.metrics[category][name] += value;
    }
  }

  /**
   * Record cache hit
   */
  recordCacheHit() {
    this.increment('cache', 'hits');
  }

  /**
   * Record cache miss
   */
  recordCacheMiss() {
    this.increment('cache', 'misses');
  }

  /**
   * Record WhatsApp message sent
   */
  recordMessageSent() {
    this.increment('whatsapp', 'messagesSent');
  }

  /**
   * Record WhatsApp message received
   */
  recordMessageReceived() {
    this.increment('whatsapp', 'messagesReceived');
  }

  /**
   * Record WhatsApp send error
   */
  recordSendError() {
    this.increment('whatsapp', 'sendErrors');
  }

  /**
   * Record database operation
   */
  recordDbOperation() {
    this.increment('database', 'operations');
  }

  /**
   * Record database error
   */
  recordDbError() {
    this.increment('database', 'errors');
  }

  /**
   * Record request
   * @param {string} type - Request type (webhook, health, etc.)
   */
  recordRequest(type = 'total') {
    this.increment('requests', 'total');
    if (type !== 'total') {
      this.increment('requests', type);
    }
  }

  /**
   * Record response
   * @param {string} type - Response type (success, error, rateLimited)
   */
  recordResponse(type) {
    this.increment('responses', type);
  }

  /**
   * Get current metrics
   * @returns {Object} Current metrics object
   */
  getMetrics() {
    const now = Date.now();
    const uptimeSeconds = Math.floor((now - this.metrics.uptime) / 1000);
    
    return {
      ...this.metrics,
      uptime: uptimeSeconds,
      cache: {
        ...this.metrics.cache,
        hitRate: this.getCacheHitRate(),
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Calculate cache hit rate
   * @returns {number} Hit rate as percentage
   */
  getCacheHitRate() {
    const { hits, misses } = this.metrics.cache;
    const total = hits + misses;
    return total > 0 ? ((hits / total) * 100).toFixed(2) : 0;
  }

  /**
   * Get summary statistics
   * @returns {Object} Summary statistics
   */
  getSummary() {
    const metrics = this.getMetrics();
    
    return {
      uptime: `${metrics.uptime}s`,
      totalRequests: metrics.requests.total,
      successRate: this.getSuccessRate(),
      cacheHitRate: `${metrics.cache.hitRate}%`,
      messagesProcessed: metrics.whatsapp.messagesReceived,
      messagesSent: metrics.whatsapp.messagesSent,
      dbOperations: metrics.database.operations,
      errors: {
        responses: metrics.responses.error,
        whatsapp: metrics.whatsapp.sendErrors,
        database: metrics.database.errors,
      },
    };
  }

  /**
   * Calculate success rate
   * @returns {string} Success rate as percentage
   */
  getSuccessRate() {
    const { success, error } = this.metrics.responses;
    const total = success + error;
    return total > 0 ? `${((success / total) * 100).toFixed(2)}%` : '0%';
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.metrics = {
      requests: { total: 0, webhook: 0, health: 0 },
      responses: { success: 0, error: 0, rateLimited: 0 },
      cache: { hits: 0, misses: 0 },
      whatsapp: { messagesSent: 0, messagesReceived: 0, sendErrors: 0 },
      database: { operations: 0, errors: 0 },
      uptime: Date.now(),
    };
  }
}

// Create global metrics instance
const metrics = new MetricsCollector();

/**
 * Express middleware to track requests
 */
function metricsMiddleware(req, res, next) {
  const startTime = Date.now();
  
  // Track request
  let requestType = 'total';
  if (req.path === '/webhook') {
    requestType = 'webhook';
  } else if (req.path === '/health') {
    requestType = 'health';
  }
  metrics.recordRequest(requestType);
  
  // Intercept response
  const originalSend = res.send;
  res.send = function(body) {
    const responseTime = Date.now() - startTime;
    
    // Track response based on status code
    if (res.statusCode >= 200 && res.statusCode < 300) {
      metrics.recordResponse('success');
    } else if (res.statusCode === 429) {
      metrics.recordResponse('rateLimited');
    } else {
      metrics.recordResponse('error');
    }
    
    // Log slow requests
    if (responseTime > 5000) {
      console.warn(`[WARN] Slow request: ${req.method} ${req.path} took ${responseTime}ms`);
    }
    
    return originalSend.call(this, body);
  };
  
  next();
}

/**
 * Logs metrics summary periodically
 */
function startMetricsLogging(intervalMs = 300000) { // 5 minutes
  setInterval(() => {
    const summary = metrics.getSummary();
    console.log('[INFO] Metrics Summary:', JSON.stringify(summary, null, 2));
  }, intervalMs);
}

module.exports = {
  MetricsCollector,
  metrics,
  metricsMiddleware,
  startMetricsLogging,
};