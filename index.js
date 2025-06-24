import { GoogleAuth } from "google-auth-library";
import express from "express";
import logger from "morgan";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import fetch from "node-fetch";

const app = express();

dotenv.config();

const ENGINE_URL = process.env.ENGINE_URL;
const cannotProcessRequestText =
  "죄송합니다. 지금은 요청을 처리할 수 없습니다.";

// Template function for KakaoTalk response format
function createKakaoResponse(text) {
  return {
    version: "2.0",
    template: {
      outputs: [
        {
          simpleText: {
            text: text,
          },
        },
      ],
    },
  };
}

const auth = new GoogleAuth();
let engineClient;

async function initializeEngineClient() {
  try {
    engineClient = await auth.getIdTokenClient(ENGINE_URL);
    console.log("Engine client initialized successfully");
  } catch (error) {
    console.error("Failed to initialize engine client:", error);
  }
}

const apiRouter = express.Router();

app.use(logger("dev", {}));
app.use(express.json());
app.use("/api", apiRouter);

apiRouter.post("/message", async function (req, res) {
  try {
    const { userRequest, bot } = req.body;

    if (!userRequest || !userRequest.utterance) {
      return res.status(400).json({ error: "Missing message content" });
    }

    const prompt = userRequest.utterance.trim();
    if (!prompt) {
      return res.status(400).json({ error: "Empty message content" });
    }

    const callbackUrl = userRequest.callbackUrl;

    res.status(200).json({
      version: "2.0",
      useCallback: true,
    });

    const requestBody = {
      messages: [prompt],
      session_id: `kakaotalk-${userRequest.user?.id || randomUUID()}-${
        userRequest.user?.type || "user"
      }`,
    };

    const response = await engineClient.request({
      url: `${ENGINE_URL}/messages`,
      method: "POST",
      data: requestBody,
    });

    const engineResponse = response.data;
    let responseText = cannotProcessRequestText;

    if (
      engineResponse &&
      engineResponse.messages &&
      engineResponse.messages.length > 0
    ) {
      responseText = engineResponse.messages[0];
    }

    const responseBody = createKakaoResponse(responseText);

    // If callback URL is provided, send the response there
    if (callbackUrl) {
      // POST the response to the callback URL
      try {
        await fetch(callbackUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(responseBody),
        });
      } catch (error) {
        console.error("Error sending callback:", error);
      }
    }
  } catch (error) {
    console.error("Error with engine API:", error);

    const errorResponse = createKakaoResponse(cannotProcessRequestText);

    res.status(500).send(errorResponse);
  }
});

// Health check endpoint
apiRouter.get("/health", function (req, res) {
  res.status(200).json({ status: "ok" });
});

async function startBot() {
  try {
    // Initialize API client
    await initializeEngineClient();

    app.listen(3000, function () {
      console.log("Example skill server listening on port 3000!");
    });
  } catch (error) {
    console.error("Failed to start the bot:", error);
  }
}

startBot();
