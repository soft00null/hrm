# HRM Bot - Multi-Tenant Healthcare Management Bot

A sophisticated multi-tenant healthcare management bot that handles WhatsApp integration with multiple organizations for appointment booking, support tickets, knowledge base queries, and symptom assessment.

## Features

- **Multi-tenant WhatsApp Integration**: Support for multiple healthcare organizations
- **Appointment Management**: Book, reschedule, and cancel appointments
- **Support Tickets**: Create and manage support requests
- **Knowledge Base**: AI-powered search through healthcare information
- **Symptom Assessment**: Intelligent symptom evaluation with doctor recommendations
- **Real-time Notifications**: Automated notifications and reminders
- **User Registration**: Streamlined patient registration flow

## Recent Enhancements

### Code Quality & Security
- ✅ **Modular Configuration**: Centralized configuration management with environment variables
- ✅ **Input Validation**: Comprehensive input sanitization and validation middleware
- ✅ **Error Handling**: Centralized error handling with proper logging
- ✅ **Rate Limiting**: Protection against abuse with configurable rate limits
- ✅ **Constants Management**: Extracted magic numbers and strings into constants
- ✅ **Health Monitoring**: Added health check endpoint for system monitoring

### Performance & Reliability
- ✅ **Enhanced Logging**: Improved error tracking and debugging
- ✅ **Secure Headers**: Better security through middleware
- ✅ **Memory Management**: Cleanup of rate limiting data to prevent memory leaks
- ✅ **Async Error Handling**: Proper error handling for async operations

## Setup

### Prerequisites
- Node.js v18 or higher
- Firebase project with Firestore enabled
- WhatsApp Business API access
- OpenAI API key

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables (create `.env` file):
```env
WHATSAPP_TOKEN=your_whatsapp_token
WHATSAPP_PHONE_ID=your_phone_id
VERIFY_TOKEN=your_verify_token
OPENAI_API_KEY=your_openai_key
FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
PORT=8080
NODE_ENV=development
```

3. For local development, add Firebase service account key:
   - Download `serviceAccountKey.json` from Firebase Console
   - Place it in the project root

### Running the Application

#### Development
```bash
npm start
```

#### Production (Google Cloud Functions)
The application is configured to run as a Google Cloud Function. Deploy using:
```bash
gcloud functions deploy Test --runtime nodejs20 --trigger-http
```

## API Endpoints

### Webhook Endpoints
- `GET /webhook` - WhatsApp webhook verification
- `POST /webhook` - WhatsApp message processing

### Health Check
- `GET /health` - System health status

## Architecture

### Core Components

- **Configuration Management** (`config.js`): Centralized environment variable handling
- **Constants** (`constants.js`): Application constants and magic numbers
- **Input Validation** (`validation.js`): Request validation and sanitization
- **Error Handling** (`errorHandler.js`): Centralized error management
- **Rate Limiting** (`rateLimit.js`): Request rate limiting and abuse protection
- **Main Application** (`index.js`): Core bot logic and webhook handling

### Security Features

- Input sanitization to prevent XSS attacks
- Rate limiting to prevent abuse
- Proper error handling to avoid information disclosure
- Environment variable validation
- Request signature validation (framework ready)

### Performance Optimizations

- In-memory rate limiting with cleanup
- Efficient message truncation
- Async error handling
- Health check endpoint for monitoring

## Configuration Options

All configuration is managed through environment variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `WHATSAPP_TOKEN` | WhatsApp API access token | Yes |
| `WHATSAPP_PHONE_ID` | WhatsApp phone number ID | Yes |
| `VERIFY_TOKEN` | Webhook verification token | Yes |
| `OPENAI_API_KEY` | OpenAI API key for AI features | Yes |
| `FIREBASE_STORAGE_BUCKET` | Firebase storage bucket name | No |
| `PORT` | Server port (default: 8080) | No |
| `NODE_ENV` | Environment (development/production) | No |
| `ENABLE_RATE_LIMITING` | Enable rate limiting (default: true) | No |
| `LOG_LEVEL` | Logging level (default: info) | No |

## Rate Limiting

The system implements configurable rate limiting:
- **General endpoints**: 100 requests per 15 minutes per IP
- **Webhook endpoints**: 50 requests per 15 minutes per phone number
- Automatic cleanup of old rate limit data

## Error Handling

Comprehensive error handling includes:
- Centralized error logging
- Async operation wrapping
- Database operation safety
- API call retry logic with exponential backoff
- Global uncaught exception handling

## Monitoring

- Health check endpoint at `/health`
- Structured error logging
- Configuration validation on startup
- Rate limit headers in responses

## Development

### Code Structure
```
/
├── index.js              # Main application
├── config.js             # Configuration management
├── constants.js          # Application constants
├── validation.js         # Input validation
├── errorHandler.js       # Error handling
├── rateLimit.js         # Rate limiting
├── package.json         # Dependencies
└── README.md           # Documentation
```

### Best Practices
- Always validate configuration on startup
- Use constants instead of magic numbers
- Implement proper error handling for all async operations
- Test rate limiting and validation middleware
- Monitor health endpoint in production

## Future Enhancements

- Advanced analytics and reporting
- Multi-language support (i18n)
- WebSocket support for real-time notifications
- Enhanced search capabilities
- Comprehensive test suite
- CI/CD pipeline with automated deployment

## License

MIT License