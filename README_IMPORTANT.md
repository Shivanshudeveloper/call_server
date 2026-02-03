# ⚠️ CRITICAL: Call Forwarding Setup

## Why Your Target Phone Is Not Ringing

The #1 reason call forwarding doesn't work is: **You don't have a SOURCE_PHONE configured!**

### What is SOURCE_PHONE?

`SOURCE_PHONE` is **YOUR Azure Communication Services phone number** that you must purchase from Azure. It's different from the TARGET_PHONE:

| Variable | What It Is | Example |
|----------|-----------|---------|
| **SOURCE_PHONE** | Phone number YOU own from Azure (shows as caller ID) | `+18885551234` |
| **TARGET_PHONE** | Phone number you want to forward calls TO (any number) | `+918392930664` |

### Why It's Required

When Azure forwards a call by "adding a participant", it needs to show a caller ID to the receiving phone. That caller ID must be a phone number you own through Azure Communication Services. Without it, the call cannot be forwarded.

## Quick Fix

### Step 1: Get an Azure Phone Number

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to your Communication Services resource
3. Click "Phone Numbers" → "Get"
4. Purchase a phone number (recommended: US toll-free)
   - Cost: ~$1-5/month
   - Choose "Make calls" capability
5. Copy the number (format: +18885551234)

### Step 2: Configure SOURCE_PHONE

Create a `.env` file in the `call_server` directory:

```bash
cp .env.example .env
```

Edit `.env` and add your Azure phone number:

```env
# YOUR Azure phone number (the one you just purchased)
SOURCE_PHONE=+18885551234

# Other config...
ACS_CONNECTION_STRING=endpoint=https://...;accesskey=...
TARGET_PHONE=+918392930664
CALLBACK_URL=https://your-ngrok-url.ngrok-free.app/api/callbacks
```

### Step 3: Restart Server

```bash
node server.js
```

You should see:
```
📱 Source phone (caller ID): +18885551234 ✅
```

**NOT this:**
```
📱 Source phone (caller ID): NOT CONFIGURED ❌
```

## How It Works

```
Incoming Call → Your Azure Number (SOURCE_PHONE)
              ↓
         Server Answers
              ↓
    Adds Target as Participant
    (using SOURCE_PHONE as caller ID)
              ↓
     Target Phone Rings (TARGET_PHONE)
              ↓
        Both Parties Connected
```

## Testing

1. **Call your SOURCE_PHONE** (the Azure number)
2. Server answers automatically
3. Your TARGET_PHONE should ring
4. Answer your target phone
5. Both phones are connected!

## Cost

- Phone number: ~$1-5/month (one-time purchase)
- Incoming calls: ~$0.01/minute
- Outgoing calls: ~$0.01-0.10/minute (depends on destination)

## Troubleshooting

### Still not ringing?

1. **Check SOURCE_PHONE is set**: Server should show "Source phone (caller ID): +1..." not "NOT CONFIGURED"
2. **Check phone number format**: Must include + and country code (+18885551234)
3. **Verify phone number exists**: Go to Azure Portal → Phone Numbers and confirm you see it
4. **Check phone capabilities**: Number must have "Make calls" capability
5. **Try US numbers first**: Indian numbers have limited Azure support
6. **Check callback URL**: Make sure ngrok is running and URL is correct
7. **Check logs**: Look for "✅ Participant added" or error messages

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| "Route not found" | Wrong API endpoint | Code handles this automatically |
| "Target phone not ringing" | SOURCE_PHONE not configured | Add SOURCE_PHONE to .env |
| "Invalid play source" | Wrong media format | Code handles this automatically |
| "Callback failed" | ngrok not running | Start ngrok http 3000 |

## Need Help?

See `SETUP_GUIDE.md` for detailed step-by-step instructions.

## Key Points

✅ **SOURCE_PHONE is required** - must be a phone number you own from Azure  
✅ **TARGET_PHONE can be any number** - the number you want to forward calls to  
✅ **Both must be in E.164 format** - +[country code][number]  
✅ **US numbers are most reliable** - better Azure support than other regions  
✅ **Callback URL must be public** - use ngrok for local testing  

