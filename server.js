const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(bodyParser.json()); // parse JSON bodies

// ----------------------
// 🔑 Firebase Admin Init from ENV
// ----------------------
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf-8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const PORT = process.env.PORT || 5000;
const COINS_REWARD = parseInt(process.env.COINS_REWARD) || 25;

// ----------------------
// 🔔 Push Notification Helper
// ----------------------
async function sendPushNotification(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;

  const validTokens = tokens.filter(token => token);
  if (validTokens.length === 0) return;

  try {
    for (const token of validTokens) {
      try {
        const message = { token, notification: { title, body }, data };
        await admin.messaging().send(message);
        console.log("Push sent to token:", token);
      } catch (error) {
        if (error.code === "messaging/registration-token-not-registered") {
          console.warn("Invalid FCM token, removing from Firestore:", token);
          const userSnapshot = await db.collection("users").where("fcmToken", "==", token).get();
          userSnapshot.forEach(async doc => {
            await doc.ref.update({ fcmToken: "" });
          });
        } else {
          console.error("Error sending push to token:", token, error);
        }
      }
    }
  } catch (error) {
    console.error("Error in sendPushNotification:", error);
  }
}

// ----------------------
// 📝 Admin Assign Task
// ----------------------
app.post("/assign-task", async (req, res) => {
  try {
    const { userId, title, description, taskId } = req.body;
    if (!userId || !taskId || !title) {
      return res.status(400).json({ success: false, error: "userId, taskId & title required" });
    }

    const userDoc = await db.collection("users").doc(userId).get();
    const token = userDoc.data()?.fcmToken;

    if (token) {
      await sendPushNotification([token], "📌 New Task Assigned!", `Task: ${title}`, { taskId });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Push Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------
// 🔹 Admin Approve/Reject Task
// ----------------------
app.post("/approve-task", async (req, res) => {
  try {
    const { taskId, approve } = req.body;
    if (!taskId || approve === undefined)
      return res.status(400).json({ success: false, error: "taskId & approve required" });

    const taskRef = db.collection("tasks").doc(taskId);
    const taskDoc = await taskRef.get();
    if (!taskDoc.exists) return res.status(404).json({ success: false, error: "Task not found" });

    const taskData = taskDoc.data();
    const status = approve ? "Completed" : "Rejected";

    await taskRef.update({ status, approvedAt: admin.firestore.FieldValue.serverTimestamp() });

    const assignedEmail = taskData.assignedTo;
    if (!assignedEmail) return res.status(400).json({ success: false, error: "Task missing assignedTo email" });

    const userQuery = await db.collection("users").where("email", "==", assignedEmail).get();
    if (userQuery.empty) return res.status(404).json({ success: false, error: "User not found" });

    const userDoc = userQuery.docs[0];
    const userRef = db.collection("users").doc(userDoc.id);

    if (approve) {
      await userRef.update({ coins: admin.firestore.FieldValue.increment(taskData.coins || COINS_REWARD) });
    }

    const token = userDoc.data()?.fcmToken;
    if (token) {
      await sendPushNotification(
        [token],
        approve ? "Task Approved ✅" : "Task Rejected ❌",
        `Task: ${taskData.title}`,
        { taskId }
      );
    }

    res.status(200).json({ success: true, status });
  } catch (error) {
    console.error("Error in /approve-task:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------
// Health Check
// ----------------------
app.get("/", (req, res) => res.send("TaskNest Backend is running!"));

// ----------------------
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
