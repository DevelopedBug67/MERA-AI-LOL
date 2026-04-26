const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

// Define the secret for the BOMOU API Key
// Set this using the Firebase CLI: firebase functions:secrets:set BOMOU_API_KEY
const bomouApiKey = defineSecret("BOMOU_API_KEY");

/**
 * 1. Cloud Function to generate a video proxy.
 * Client calls this with a script and settings.
 * This is an onCall function which automatically verifies standard auth.
 */
exports.generateVideoProxy = onCall({ secrets: [bomouApiKey] }, async (request) => {
  // 1. Verify Authentication
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "You must be logged in to generate a video."
    );
  }

  const { script, settings } = request.data;
  const userId = request.auth.uid;

  // 2. Validate Input
  if (!script || typeof script !== "string" || script.trim().length === 0) {
    throw new HttpsError("invalid-argument", "Script cannot be empty.");
  }

  if (script.length > 500) {
    throw new HttpsError("invalid-argument", "Script cannot exceed 500 characters.");
  }

  try {
    const db = admin.firestore();
    
    // 3. Create a Firestore document with 'processing' status
    const videoRef = await db.collection("videos").add({
      userId,
      script,
      settings: settings || {},
      status: "processing",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const videoId = videoRef.id;

    // 4. Make HTTP request to BOMOU API
    // The webhook URL dynamically points to your Cloud Functions project.
    const webhookUrl = `https://${process.env.GCLOUD_PROJECT}.cloudfunctions.net/bomouWebhook`;
    
    // Replace with the actual BOMOU API endpoint
    const bomouApiEndpoint = "https://api.bomou.com/v1/generate"; 

    const response = await fetch(bomouApiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${bomouApiKey.value()}`,
      },
      body: JSON.stringify({
        script,
        settings,
        webhook_url: webhookUrl,
        reference_id: videoId, // Send our Firestore doc ID to map it back in the webhook
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      logger.error("BOMOU API Error:", errorData);
      
      // Mark as failed if API rejects immediately
      await videoRef.update({ 
        status: "failed", 
        error: "API rejected the request.",
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      throw new HttpsError("internal", "Failed to start video generation with the provider.");
    }

    // Successfully sent to BOMOU, the webhook will handle the rest.
    return { success: true, videoId };

  } catch (error) {
    logger.error("Error in generateVideoProxy:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "An internal error occurred.");
  }
});

/**
 * 2. Webhook to receive completion status from BOMOU API.
 * This is an onRequest function as it's called by an external system.
 */
exports.bomouWebhook = onRequest(async (req, res) => {
  // BOMOU should send back the generated videoUrl and our original reference_id (videoId)
  const { video_url, reference_id, status } = req.body;

  if (!reference_id) {
    logger.warn("Webhook received without reference_id");
    res.status(400).send("Missing reference_id");
    return;
  }

  try {
    const db = admin.firestore();
    const videoRef = db.collection("videos").doc(reference_id);

    // Verify the document exists before updating
    const docSnap = await videoRef.get();
    if (!docSnap.exists) {
      logger.warn(`Webhook received for unknown video ID: ${reference_id}`);
      res.status(404).send("Video reference not found");
      return;
    }

    if (status === "failed") {
        await videoRef.update({
            status: "failed",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } else {
        // Update Firestore document with completion status and URL
        await videoRef.update({
            status: "completed",
            videoUrl: video_url,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    }

    res.status(200).send("Webhook processed successfully");
  } catch (error) {
    logger.error("Error processing webhook:", error);
    res.status(500).send("Internal server error");
  }
});
