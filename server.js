// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const { CommunicationIdentityClient } = require('@azure/communication-identity');
const cors = require('cors');
const app = express();


app.use(cors());

// Replace with your connection string (or use environment variable)
const connectionString = process.env.ACS_CONNECTION_STRING; 
if (!connectionString) {
    console.error("Please set the ACS_CONNECTION_STRING in your .env file!");
    process.exit(1);
}

const identityClient = new CommunicationIdentityClient(connectionString);

// Serve static files from the React app build (after you run `npm run build` in client)
app.use(express.static(path.join(__dirname, 'client/build')));

app.get('/token', async (req, res) => {
  try {
    // Create a new user and issue a token
    const user = await identityClient.createUser();
    const tokenResponse = await identityClient.getToken(user, ["voip"]);

    res.json({
      userId: user.communicationUserId,
      token: tokenResponse.token,
      expiresOn: tokenResponse.expiresOn
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error generating token");
  }
});

// Catch-all: return React index file if no other route matches
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build', 'index.html'));
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
