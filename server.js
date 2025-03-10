const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Initialize Express app first
const app = express();

// Set trust proxy IMMEDIATELY after creating the app
// This must come before any middleware
app.set('trust proxy', 1);

// Load configuration
const config = {
   port: process.env.PORT || 4000,
   token: process.env.TOKEN,
   allowedOrigins: [
      'https://www.billybear.fun',  // No trailing slash
      'https://billybear.fun',      // Add non-www version
      'https://billybear-dknx.vercel.app', // Add Vercel domain
      'http://localhost:80',
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://127.0.0.1:80',
      'null'  // For file:// protocol
   ],
   rateLimit: {
      windowMs: 60 * 1000, // 1 minute
      max: 60
   },
   gemini: {
      model: 'gemini-1.5-flash',
      maxHistoryLength: 10
   }
};

// Initialize Gemini
const genAI = new GoogleGenerativeAI(config.token);

// Load bot prompt once at startup
let bot1Prompt;
try {
   bot1Prompt = JSON.parse(fs.readFileSync('./prompts/billybear.json', 'utf8'));
} catch (error) {
   console.error('Failed to load bot prompt:', error);
   process.exit(1);
}

// CORS configuration
app.use(
   cors({
      origin: (origin, callback) => {
         // Allow requests with no origin (like file:// or mobile apps)
         if (!origin || origin === 'null') {
            return callback(null, true);
         }
         
         // Check if the origin is allowed
         const isAllowed = config.allowedOrigins.some(allowedOrigin => 
            origin.startsWith(allowedOrigin)
         );
         
         if (isAllowed) {
            callback(null, true);
         } else {
            console.log('Blocked origin:', origin);  // For debugging
            callback(new Error('Not allowed by CORS'));
         }
      },
      credentials: true
   })
);

app.use(bodyParser.json());

// Configure rate limiter with explicit trust proxy settings
const limiter = rateLimit({
   windowMs: config.rateLimit.windowMs,
   max: config.rateLimit.max,
   message: 'Too many requests from this IP, please try again later.',
   standardHeaders: true,
   legacyHeaders: false,
   // Explicitly set the key generator to use the correct IP
   keyGenerator: (req) => {
      return req.ip || req.connection.remoteAddress;
   }
});

app.use('/chat', limiter);

// Helper functions
const cleanMessage = (message) => 
   message.replace(/<.*?>/g, '').replace(/^You:\s*/, '').trim();

const createSystemPrompt = (botPrompt) => {
   const { description, personality, instructions } = botPrompt;
   
   return `You are a friendly AI assistant engaging in casual conversation. Please respond in a helpful and appropriate manner.

Key Characteristics:
- Friendly and professional demeanor
- Helpful and informative responses
- Family-friendly content only
- Focus on positive interactions

Guidelines:
1. Keep responses appropriate and friendly
2. Avoid controversial topics
3. Stay focused on helpful information
4. Maintain professional boundaries

Please respond to the user's message in a helpful and appropriate way.`;
};

// Add retry helper function at the top of your file
const retryWithDelay = async (fn, retries = 3, delay = 1000) => {
   for (let i = 0; i < retries; i++) {
      try {
         return await fn();
      } catch (error) {
         console.error(`Attempt ${i+1} failed:`, error.message);
         if (i === retries - 1) throw error;
         
         // Retry on 503 Service Unavailable or other temporary errors
         if (error.status === 503 || error.message?.includes('timeout') || error.message?.includes('network')) {
            console.log(`Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
            continue;
         }
         throw error;
      }
   }
};

// Add this near the top of your file
const logRequest = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });
  next();
};

// Add this middleware before your routes
app.use(logRequest);

// Add this function to debug available models
const listAvailableModels = async () => {
  try {
    const models = await genAI.listModels();
    console.log("Available models:");
    models.models.forEach(model => {
      console.log(`- ${model.name} (${model.displayName})`);
    });
  } catch (error) {
    console.error("Error listing models:", error);
  }
};

// Add this function to provide fallback responses
const getFallbackResponse = (message) => {
  const fallbackResponses = [
    "I'm currently experiencing high demand. Could you try again in a few minutes?",
    "My systems are a bit busy right now. I'll be back to full capacity shortly!",
    "I apologize for the inconvenience, but I'm temporarily unavailable. Please try again later."
  ];
  
  return fallbackResponses[Math.floor(Math.random() * fallbackResponses.length)];
};

// Add a simple in-memory cache
const responseCache = new Map();

// Add a fallback service function
const getResponseFromFallbackService = async (message) => {
  // This could be another AI service or a simple rule-based response system
  return `I'm currently experiencing technical difficulties. Your message was: "${message}"`;
};

// Modify the chat endpoint to better handle Gemini's context
app.post('/chat', async (req, res) => {
   try {
      const { messages } = req.body;

      if (!messages || !Array.isArray(messages)) {
         return res.status(400).json({ error: 'Invalid messages format' });
      }

      // Create a cache key from the last message
      const lastMessage = messages[messages.length - 1].message;
      const cacheKey = lastMessage.toLowerCase().trim();
      
      // Check cache first
      if (responseCache.has(cacheKey)) {
         console.log("Cache hit for:", cacheKey);
         return res.json({ reply: responseCache.get(cacheKey) });
      }

      // Clean messages
      const cleanedMessages = messages.map((msg) => cleanMessage(msg.message));

      // Call this function before trying to use the model
      await listAvailableModels();

      // Get the model
      const model = genAI.getGenerativeModel({ 
         model: config.gemini.model,
         safetySettings: [
            {
               category: "HARM_CATEGORY_HARASSMENT",
               threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
               category: "HARM_CATEGORY_HATE_SPEECH",
               threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
               category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
               threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
               category: "HARM_CATEGORY_DANGEROUS_CONTENT",
               threshold: "BLOCK_MEDIUM_AND_ABOVE"
            }
         ],
         generationConfig: {
            maxOutputTokens: 1000,
            temperature: 0.7,
            topP: 0.7,
            topK: 20
         }
      });

      // Start the chat
      const chat = model.startChat({
         history: [],
      });

      // Add system prompt with retry
      await retryWithDelay(async () => {
         await chat.sendMessage(`${createSystemPrompt(bot1Prompt)}\n\nPlease respond as BillyBear, maintaining character throughout the conversation.`);
      });

      // Send previous messages with retry
      const recentMessages = cleanedMessages.slice(-config.gemini.maxHistoryLength);
      for (const msg of recentMessages.slice(0, -1)) {
         await retryWithDelay(async () => {
            await chat.sendMessage(`User: ${msg}\nPlease respond as BillyBear, keeping your character traits in mind.`);
         });
      }

      // Send the final message with retry
      const result = await retryWithDelay(async () => {
         return await chat.sendMessage(
            `User: ${recentMessages[recentMessages.length - 1]}\nPlease provide a helpful and appropriate response.`
         );
      });
      
      const response = await result.response;
      const botReply = response.text()
         .replace(/^Assistant:|^AI:/, '')
         .trim();

      // Cache the response before returning
      responseCache.set(cacheKey, botReply);
      
      res.json({ reply: botReply });

   } catch (error) {
      console.error('Error in chat endpoint:', error);
      
      // Create a friendly variable to store the user's message for fallback responses
      const userMessage = req.body.messages && req.body.messages.length > 0 
         ? req.body.messages[req.body.messages.length - 1].message 
         : "your question";
      
      // Handle different error types with friendly responses
      if (error.message?.includes('429') || error.message?.includes('quota') || error.message?.includes('exhausted')) {
         return res.json({ 
            reply: "I'm having a little difficulty processing requests right now. Could you try again in a few moments? My systems need a quick breather! 🐻"
         });
      }
      
      if (error.message?.includes('SAFETY')) {
         return res.json({ 
            reply: "I'm having a little trouble with that question. Could you try asking something else? I'd be happy to help with another topic! 🐻"
         });
      }
      
      if (error.message?.includes('timeout') || error.message?.includes('network')) {
         return res.json({ 
            reply: "Oops! My connection is a bit fuzzy at the moment. Could you try again? I'm eager to continue our conversation! 🐻"
         });
      }
      
      // Default friendly response for any other errors
      return res.json({ 
         reply: "I seem to be having a little difficulty right now. Could you try asking again in a different way? I'm still learning! 🐻"
      });
   }
});

// Add a health check endpoint
app.get('/', (req, res) => {
  res.status(200).send({
    status: 'ok',
    message: 'BillyBear Chat Server is running',
    timestamp: new Date().toISOString()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
   console.error('Unhandled error:', err);
   res.status(500).json({ error: 'Internal server error' });
});

// Start server if not running in Vercel
if (process.env.VERCEL) {
  // Export the Express app for Vercel
  module.exports = app;
} else {
  // Start server on all interfaces for local development
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${config.port}`);
  });
}
