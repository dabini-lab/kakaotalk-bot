import { GoogleAuth } from "google-auth-library";
import express from "express";
import logger from "morgan";
import dotenv from "dotenv";
import { randomUUID } from "crypto";

const app = express();

dotenv.config();

const ENGINE_URL = process.env.ENGINE_URL;
const DEBUG_MODE =
  process.env.DEBUG_MODE === "true" || process.env.NODE_ENV === "development";
const cannotProcessRequestText =
  "지금은 요청을 처리할 수 없어. 나중에 시도해 줘.";

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
function createImageResponse(
  imageUrl,
  altText = "Generated image",
  description = null
) {
  // description이 있으면 simpleText와 simpleImage를 함께 반환
  const outputs = [];
  if (description) {
    outputs.push({
      simpleText: {
        text: description,
      },
    });
  }
  outputs.push({
    simpleImage: {
      imageUrl: imageUrl,
      altText: altText,
    },
  });
  return {
    version: "2.0",
    template: {
      outputs: outputs,
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
      data: { text: "응, 잠시만 기다려 줘." },
    });

    // Async: Generate image and send result to callbackUrl
    (async () => {
      let responseBody;
      try {
        try {
          const userId = userRequest.user?.id;
          const sessionId = `kakaotalk-group-${userRequest.chat?.id}`;
          const requestBody = {
            message: prompt,
            user_id: userId || randomUUID(),
            session_id: sessionId || randomUUID(),
          };
          if (DEBUG_MODE) {
            console.log(
              `message, user_id, session_id: ${prompt}, ${userId}, ${sessionId}`
            );
          }

          const imageRes = await engineClient.request({
            url: `${ENGINE_URL}/kakao/message`,
            method: "POST",
            data: requestBody,
          });
          const imageData = imageRes.data;
          if (
            imageData.success &&
            imageData.is_returning_image &&
            imageData.image_url
          ) {
            // 응답 메시지와 이미지 URL을 함께 사용
            const description = imageData.response_message;
            responseBody = createImageResponse(
              imageData.image_url,
              prompt,
              description
            );
          } else {
            // 이미지 생성이 실패했거나 이미지 요청이 아닌 경우
            const errorMessage = imageData.error
              ? `${cannotProcessRequestText}\n(${imageData.error})`
              : imageData.response_message || cannotProcessRequestText;
            responseBody = createKakaoResponse(errorMessage);
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
