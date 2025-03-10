#!/bin/bash
set -e  # Exit immediately if a command exits with a non-zero status

echo "Node version:"
node --version

echo "NPM version:"
npm --version

echo "Current directory:"
pwd

echo "Directory contents:"
ls -la

echo "Installing dependencies directly..."
npm install express@4.18.2 body-parser@1.20.2 cors@2.8.5 dotenv@16.3.1 @google/generative-ai@0.1.3 express-rate-limit@7.1.5

echo "Checking node_modules:"
ls -la node_modules

echo "Dependencies installed successfully!" 