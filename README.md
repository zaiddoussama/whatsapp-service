# WhatsApp Web.js Service

WhatsApp Web API service using whatsapp-web.js for AI Agent integration.

## Features

- ✅ Multi-user session management
- ✅ QR code authentication
- ✅ Send/receive text messages
- ✅ Send media messages
- ✅ Bulk message support with anti-spam delays
- ✅ Webhooks to Spring Boot backend
- ✅ Persistent sessions (survives restarts)
- ✅ API key authentication

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```env
PORT=3000
SPRING_BOOT_URL=http://localhost:8080/api
API_KEY=your-api-key
WEBHOOK_API_KEY=your-webhook-key
```

## Running

```bash
# Development
npm run dev

# Production
npm start
```

## API Endpoints

### Initialize WhatsApp
```bash
POST /api/init
{
  "userId": 1
}
```

### Get QR Code
```bash
GET /api/qr/:userId
```

### Send Message
```bash
POST /api/send-message
{
  "userId": 1,
  "to": "212645923046",
  "message": "Hello!"
}
```

### Send Bulk Messages
```bash
POST /api/send-bulk
{
  "userId": 1,
  "messages": [
    {"to": "212645923046", "message": "Hello 1"},
    {"to": "212645923047", "message": "Hello 2"}
  ]
}
```

### Get Status
```bash
GET /api/status/:userId
```

### Disconnect
```bash
POST /api/disconnect
{
  "userId": 1
}
```

### Health Check
```bash
GET /api/health
```

## Webhooks to Spring Boot

The service sends webhooks to your Spring Boot backend:

- `POST /api/whatsapp/qr-ready` - QR code generated
- `POST /api/whatsapp/connected` - WhatsApp connected
- `POST /api/whatsapp/message-received` - Message received
- `POST /api/whatsapp/disconnected` - Disconnected
- `POST /api/whatsapp/auth-failed` - Auth failed

## Security

All API requests require `X-API-Key` header (except `/api/health`).

## Notes

- Sessions are stored in `./storage/sessions/`
- Each user gets a separate WhatsApp session
- Messages have 3-8 second delays in bulk sending
- QR codes expire after 30 seconds
