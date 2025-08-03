/**
 * Configuration constants for the HRM Bot
 * Centralizes magic numbers, strings, and configuration values
 */

// API Configuration
const API_CONFIG = {
  WHATSAPP_API_VERSION: 'v17.0',
  WHATSAPP_BASE_URL: 'https://graph.facebook.com',
  KNOWLEDGE_BASE_URL: 'https://Testhospital.in/',
  OPENAI_MODEL: 'gpt-4o-mini',
  MAX_RETRY_ATTEMPTS: 3,
  REQUEST_TIMEOUT: 30000, // 30 seconds
};

// Rate Limiting
const RATE_LIMITS = {
  WINDOW_MS: 15 * 60 * 1000, // 15 minutes
  MAX_REQUESTS: 100, // per window
  WEBHOOK_MAX_REQUESTS: 50, // per window for webhooks
};

// Message Configuration
const MESSAGE_CONFIG = {
  MAX_MESSAGE_LENGTH: 4096,
  TRUNCATED_MESSAGE_LENGTH: 300,
  MAX_KNOWLEDGE_RESPONSE_LENGTH: 2000,
  ID_LENGTH: 8,
  FLOW_TOKEN_LENGTH: 6,
};

// Firebase Collections
const COLLECTIONS = {
  POC: 'PoC',
  PATIENTS: 'Patients',
  CHAT: 'Chat',
  APPOINTMENTS: 'Appointment',
  SUPPORT_TICKETS: 'SupportTickets',
  ORGANIZATIONS: 'Organisation',
};

// Message Types
const MESSAGE_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  DOCUMENT: 'document',
  INTERACTIVE: 'interactive',
};

// Chat Directions
const CHAT_DIRECTIONS = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
};

// Tool Names for OpenAI
const TOOL_NAMES = {
  APPOINTMENT_FLOW: 'appointment_flow',
  SUPPORT_TICKET: 'support_ticket',
  KNOWLEDGE_SEARCH: 'knowledge_search',
  SYMPTOM_ASSESSMENT: 'symptom_assessment',
};

// Error Messages
const ERROR_MESSAGES = {
  INVALID_INPUT: 'Invalid input provided',
  RATE_LIMIT_EXCEEDED: 'Rate limit exceeded. Please try again later.',
  INTERNAL_ERROR: 'An internal error occurred. Please try again.',
  AUTHENTICATION_FAILED: 'Authentication failed',
  MEDIA_DOWNLOAD_FAILED: 'Failed to download media file',
  DATABASE_ERROR: 'Database operation failed',
};

// Success Messages
const SUCCESS_MESSAGES = {
  APPOINTMENT_BOOKED: 'Your appointment has been successfully booked.',
  TICKET_CREATED: 'Your support ticket has been created.',
  REGISTRATION_COMPLETE: 'Registration completed successfully.',
};

module.exports = {
  API_CONFIG,
  RATE_LIMITS,
  MESSAGE_CONFIG,
  COLLECTIONS,
  MESSAGE_TYPES,
  CHAT_DIRECTIONS,
  TOOL_NAMES,
  ERROR_MESSAGES,
  SUCCESS_MESSAGES,
};