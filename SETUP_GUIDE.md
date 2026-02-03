# Azure Communication Services Call Forwarding Setup Guide

## Prerequisites

Before you can forward calls, you need:

1. **Azure Communication Services Resource**
2. **A phone number from Azure** (this is crucial!)
3. **A public URL for webhooks** (ngrok for testing)

## Step 1: Get a Phone Number from Azure

The most common issue is **not having a source phone number configured**. Here's how to get one:

### Option A: Azure Portal (Recommended)

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to your **Communication Services** resource
3. Click **Phone Numbers** in the left sidebar
4. Click **Get** or **+ Get** button
5. Choose:
   - **Capabilities**: "Make calls" (required for outbound calling)
   - **Number type**: Toll-free or Geographic
   - **Location**: Choose based on your needs
     - 🇺🇸 **US numbers** are most reliable
     - 🇮🇳 **India numbers** may have limitations
6. Complete the purchase (pricing varies by region)
7. **Copy the phone number** (format: +18885551234)

### Option B: Azure CLI

```bash
# Login to Azure
az login

# List available phone numbers
az communication phonenumber list --resource-group your-rg --resource-name your-acs

# Search for available numbers
az communication phonenumber search \
  --resource-group your-rg \
  --resource-name your-acs \
  --area-code 888 \
  --country-code US
```

## Step 2: Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and fill in:
   ```env
   # Your connection string (Azure Portal -> Keys)
   ACS_CONNECTION_STRING=endpoint=https://...;accesskey=...
   
   # YOUR Azure phone number (the one you just purchased)
   SOURCE_PHONE=+18885551234
   
   # Phone number to forward calls TO (can be any number)
   TARGET_PHONE=+918392930664
   
   # Your callback URL (see Step 3)
   CALLBACK_URL=https://abc123.ngrok-free.app/api/callbacks
   ```

## Step 3: Setup Public URL (for local testing)

```bash
# Install ngrok if you haven't
npm install -g ngrok

# Start ngrok on port 3000
ngrok http 3000

# Copy the HTTPS URL (e.g., https://abc123.ngrok-free.app)
# Update CALLBACK_URL in .env to: https://abc123.ngrok-free.app/api/callbacks
```

## Step 4: Configure Event Grid Webhook

1. Go to Azure Portal → Communication Services → Events
2. Click **+ Event Subscription**
3. Set:
   - **Name**: IncomingCallWebhook
   - **Event Schema**: Event Grid Schema
   - **Filter to Event Types**: Select "Incoming Call"
   - **Endpoint Type**: Webhook
   - **Endpoint**: `https://your-domain.com/api/incomingCall`
     - For local testing: `https://abc123.ngrok-free.app/api/incomingCall`
4. Click **Create**

## Step 5: Start the Server

```bash
cd call_server
npm install
node server.js
```

You should see:
```
========================================
🚀 Server running on port 3000
📞 Forwarding calls to: +918392930664
📱 Source phone (caller ID): +18885551234  ✅
🔗 Callback URL: https://abc123.ngrok-free.app/api/callbacks
========================================
```

**Important:** If you see `Source phone (caller ID): NOT CONFIGURED`, the forwarding **will NOT work**!

## Step 6: Test the Setup

### Test 1: Server Health
```bash
curl http://localhost:3000/
```

### Test 2: REST API Connection
```bash
curl http://localhost:3000/api/testRestApi
```

### Test 3: Make a Test Call
Call your **Azure phone number** (SOURCE_PHONE) from any phone. The call should:
1. Be received by your server
2. Answer automatically
3. Add your TARGET_PHONE as a participant
4. Ring your target phone
5. Connect both parties

## Troubleshooting

### "Route not found" errors
- **Cause**: Incorrect API endpoints or unsupported API version
- **Fix**: The code tries multiple API versions automatically. Check logs for which version works.

### Target phone not ringing
- **Cause**: Missing SOURCE_PHONE configuration
- **Solution**: Make sure SOURCE_PHONE is set to YOUR Azure phone number
- **Check**: Server startup should show "Source phone (caller ID): +1..." not "NOT CONFIGURED"

### "Invalid play source" error
- **Cause**: Incorrect media format for text-to-speech
- **Fix**: Already handled in the code with proper format

### SDK methods failing silently
- **Cause**: Known issue with Azure SDK
- **Fix**: Code uses REST API as primary method, SDK as fallback

### Indian numbers not working
- **Cause**: Azure Communication Services has limited support for India PSTN
- **Solution**: 
  - Use a US phone number as SOURCE_PHONE
  - You can still forward TO Indian numbers
  - Or use a US number as TARGET_PHONE for testing

### Callback URL not reachable
- **Cause**: ngrok not running or incorrect URL
- **Fix**: 
  ```bash
  # Make sure ngrok is running
  ngrok http 3000
  
  # Update CALLBACK_URL in .env with the HTTPS URL
  # Restart server after changing .env
  ```

## Configuration Summary

| Variable | Purpose | Example | Required |
|----------|---------|---------|----------|
| `ACS_CONNECTION_STRING` | Azure credentials | `endpoint=https://...` | ✅ Yes |
| `SOURCE_PHONE` | YOUR Azure phone (caller ID) | `+18885551234` | ✅ **Critical!** |
| `TARGET_PHONE` | Where to forward calls | `+918392930664` | ✅ Yes |
| `CALLBACK_URL` | Webhook endpoint | `https://...ngrok.../api/callbacks` | ✅ Yes |
| `PORT` | Server port | `3000` | ❌ Optional |

## How It Works

1. Someone calls your **SOURCE_PHONE** (Azure number)
2. Azure sends webhook to `/api/incomingCall`
3. Server answers the call
4. Server tries methods in order:
   - **Method 1**: Direct redirect (fastest, often fails)
   - **Method 2**: Answer + add participant via REST API (most reliable)
   - **Method 3**: Answer + transfer via REST API
   - **Method 4**: Answer + add participant via SDK
   - **Method 5**: Answer + transfer via SDK
   - **Fallback**: Answer + play message + hangup
5. If successful, **TARGET_PHONE rings** and both parties are connected

## Cost Considerations

- **Phone number**: ~$1-5/month depending on type and region
- **Incoming calls**: ~$0.01-0.02/minute
- **Outgoing calls** (to TARGET_PHONE): ~$0.01-0.10/minute depending on destination
- **PSTN rates**: Check [Azure Pricing](https://azure.microsoft.com/pricing/details/communication-services/)

## Next Steps

After successful setup:
1. Deploy to production (not ngrok)
2. Update CALLBACK_URL to your production domain
3. Update Event Grid webhook to production URL
4. Monitor logs for call quality and issues
5. Consider adding:
   - Call recording
   - Voicemail
   - IVR menu
   - Multiple target numbers
   - Database logging

## Support

If you're still having issues:
1. Check server logs for detailed error messages
2. Verify all environment variables are set correctly
3. Make sure SOURCE_PHONE is a number you own from Azure
4. Test with US numbers first (better support)
5. Check Azure Portal → Communication Services → Logs for service-level errors

