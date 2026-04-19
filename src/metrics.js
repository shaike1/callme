const logger = require('./logger');

/**
 * Per-call metrics collector
 */
class MetricsCollector {
  constructor() {
    this.callMetrics = new Map();
  }

  /**
   * Initialize metrics for new call
   */
  initCall(callId) {
    this.callMetrics.set(callId, {
      callId,
      startTime: Date.now(),
      endTime: null,
      direction: null,
      answerLatencyMs: null,
      sttCount: 0,
      sttErrors: 0,
      ttsCount: 0,
      ttsErrors: 0,
      llmCount: 0,
      llmErrors: 0,
      bargeInCount: 0,
      endReason: null,
      errors: []
    });
  }

  /**
   * Record metric
   */
  record(callId, metric, value) {
    const metrics = this.callMetrics.get(callId);
    if (!metrics) {
      logger.warn('Call not found for metric', { callId, metric });
      return;
    }

    switch (metric) {
      case 'answerLatency':
        metrics.answerLatencyMs = value;
        break;
      case 'sttSuccess':
        metrics.sttCount++;
        break;
      case 'sttError':
        metrics.sttErrors++;
        metrics.errors.push({ type: 'stt', error: value, time: Date.now() });
        break;
      case 'ttsSuccess':
        metrics.ttsCount++;
        break;
      case 'ttsError':
        metrics.ttsErrors++;
        metrics.errors.push({ type: 'tts', error: value, time: Date.now() });
        break;
      case 'llmSuccess':
        metrics.llmCount++;
        break;
      case 'llmError':
        metrics.llmErrors++;
        metrics.errors.push({ type: 'llm', error: value, time: Date.now() });
        break;
      case 'bargeIn':
        metrics.bargeInCount++;
        break;
      case 'endCall':
        metrics.endTime = Date.now();
        metrics.endReason = value;
        break;
      default:
        logger.warn('Unknown metric', { callId, metric });
    }
  }

  /**
   * Get metrics for call
   */
  get(callId) {
    return this.callMetrics.get(callId);
  }

  /**
   * Finalize and remove from active map
   */
  finalize(callId) {
    const metrics = this.callMetrics.get(callId);
    if (metrics) {
      const duration = Date.now() - metrics.startTime;
      metrics.durationMs = duration;
      
      logger.info('Call metrics finalized', metrics);
      this.callMetrics.delete(callId);
      return metrics;
    }
  }

  /**
   * Get aggregate stats
   */
  getStats() {
    const active = Array.from(this.callMetrics.values());
    
    return {
      activeCalls: active.length,
      totalSttCalls: active.reduce((sum, m) => sum + m.sttCount, 0),
      totalTtsCalls: active.reduce((sum, m) => sum + m.ttsCount, 0),
      totalLlmCalls: active.reduce((sum, m) => sum + m.llmCount, 0),
      totalErrors: active.reduce((sum, m) => sum + m.errors.length, 0)
    };
  }
}

module.exports = MetricsCollector;
