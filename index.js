import { GoogleAuth } from "google-auth-library";
import express from "express";
import logger from "morgan";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

const app = express();

dotenv.config();

const ENGINE_URL = process.env.ENGINE_URL;
const cannotProcessRequestText = "죄송합니다. 요청을 처리할 수 없습니다.";

// Template function for KakaoTalk response format
function createKakaoResponse(text = null) {
  const outputs = [];

  // Add text response if provided
  if (text) {
    outputs.push({
      simpleText: {
        text: text,
      },
    });
  }

  return {
    version: "2.0",
    template: {
      outputs: outputs,
    },
  };
}

// Function to create image response for KakaoTalk
function createImageResponse(imageUrl, altText = "Generated image") {
  return {
    version: "2.0",
    template: {
      outputs: [
        {
          simpleImage: {
            imageUrl: imageUrl,
            altText: altText,
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
    throw error; // Re-throw to handle in startBot
  }
}

const channelRouter = express.Router();
const groupRouter = express.Router();

app.use(logger("dev", {}));
app.use(express.json());
app.use("/channel", channelRouter);
app.use("/group", groupRouter);

// Health check endpoint
app.get("/health", function (req, res) {
  res.status(200).json({ status: "ok" });
});

channelRouter.post("/message", async function (req, res) {
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

// Group message endpoint
groupRouter.post("/message", async function (req, res) {
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

    // Immediately return SkillResponse to client
    res.status(200).json({
      version: "2.0",
      useCallback: true,
      data: { text: "생각하고 있는 중이에요.\n기다려 주실래요?" },
    });

    // Async: Generate image and send result to callbackUrl
    (async () => {
      let responseBody;
      try {
        const imagePrompt = prompt;
        try {
          const imageRes = await engineClient.request({
            url: `${ENGINE_URL}/image?prompt=${encodeURIComponent(
              imagePrompt
            )}`,
            method: "GET",
          });
          const imageData = imageRes.data;
          if (imageData.success && imageData.image_data) {
            responseBody = createImageResponse(
              imageData.image_data.url,
              imagePrompt
            );
          } else {
            responseBody = createKakaoResponse(
              cannotProcessRequestText + "\n(이미지 생성 실패)"
            );
          }
        } catch (error) {
          responseBody = createKakaoResponse(
            cannotProcessRequestText + "\n(이미지 생성 오류)"
          );
        }
        // If callbackUrl exists, POST the result
        if (callbackUrl) {
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
        console.error("Error with group message:", error);
        const errorResponse = createKakaoResponse(cannotProcessRequestText);
        if (callbackUrl) {
          try {
            await fetch(callbackUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify(errorResponse),
            });
          } catch (err) {
            console.error("Error sending error callback:", err);
          }
        }
      }
    })();
  } catch (error) {
    console.error("Error with group message:", error);
    const errorResponse = createKakaoResponse(cannotProcessRequestText);
    res.status(500).json(errorResponse);
  }
});

async function startBot() {
  try {
    await initializeEngineClient();

    // Start the server first
    const PORT = process.env.PORT || 8080;
    const server = app.listen(PORT, function () {
      console.log(`Example skill server listening on port ${PORT}!`);
    });

    // Handle server errors
    server.on("error", (error) => {
      console.error("Server error:", error);
    });

    // Keep the process alive
    process.on("SIGINT", () => {
      console.log("Received SIGINT, shutting down gracefully...");
      server.close(() => {
        console.log("Server closed");
        process.exit(0);
      });
    });
  } catch (error) {
    console.error("Failed to start the bot:", error);
    process.exit(1);
  }
}

startBot();
