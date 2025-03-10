const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

// Load configuration
const config = {
   port: process.env.PORT || 4000,
   token: process.env.TOKEN,
   allowedOrigins: [
      'https://www.billybear.fun',  // No trailing slash
      'https://billybear.fun',      // Add non-www version
      'https://billybear-chat-server.vercel.app', // Add Vercel domain
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
      model: 'gemini-pro',
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

const app = express();

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

// Rate limiting
const limiter = rateLimit({
   windowMs: config.rateLimit.windowMs,
   max: config.rateLimit.max,
   message: 'Too many requests from this IP, please try again later.',
   standardHeaders: true,
   legacyHeaders: false
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

// Modify the chat endpoint to better handle Gemini's context
app.post('/chat', async (req, res) => {
   try {
      const { messages } = req.body;

      if (!messages || !Array.isArray(messages)) {
         return res.status(400).json({ error: 'Invalid messages format' });
      }

      // Clean messages
      const cleanedMessages = messages.map((msg) => cleanMessage(msg.message));

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

      res.json({ reply: botReply });

   } catch (error) {
      console.error('Error in chat endpoint:', error);
      
      // More specific error handling
      if (error.message?.includes('SAFETY')) {
         return res.status(400).json({ 
            error: 'I apologize, but I cannot provide a response to that query. Please try rephrasing your question in a more appropriate way.'
         });
      }
      
      res.status(500).json({ 
         error: 'I encountered an issue processing your request. Please try again with a different question.'
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

// Start server
app.listen(config.port, () => {
   console.log(`Server is running on http://localhost:${config.port}`);
});
