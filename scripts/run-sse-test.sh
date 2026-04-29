#!/bin/bash

# HTTP Transport Test Runner Script
# Properly handles server startup, test execution, and cleanup
# Note: The script is named "sse" for backward compatibility with CI pipelines.

set -e

echo "🔧 Building project..."
npm run build

echo "🚀 Starting server for HTTP transport test..."
npm run start &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

# Function to cleanup server and any hanging processes
cleanup() {
    echo "🧹 Starting comprehensive cleanup..."
    
    # Kill the main server process
    if kill -0 $SERVER_PID 2>/dev/null; then
        echo "Terminating server (PID: $SERVER_PID)..."
        kill $SERVER_PID
        sleep 3
        # Force kill if still running
        if kill -0 $SERVER_PID 2>/dev/null; then
            echo "Force killing server..."
            kill -9 $SERVER_PID 2>/dev/null || true
        fi
    fi
    
    # Kill any lingering Node processes on port 3000
    echo "Checking for processes on port 3000..."
    PID_ON_PORT=$(lsof -ti tcp:3000 2>/dev/null || true)
    if [ ! -z "$PID_ON_PORT" ]; then
        echo "Found process on port 3000 (PID: $PID_ON_PORT), killing..."
        kill -9 $PID_ON_PORT 2>/dev/null || true
    fi
    
    # Kill any remaining node processes related to this test
    echo "Cleaning up any remaining MCP server processes..."
    pkill -f "dist/server.js" 2>/dev/null || true
    
    echo "✅ Cleanup complete"
}

# Set trap to cleanup on exit or signals
trap cleanup EXIT INT TERM

echo "⏳ Waiting for server to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/mcp -o /dev/null 2>/dev/null; then
    echo "✅ Server is listening (after ${i}s)"
    break
  fi
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "❌ Server exited before becoming ready"
    exit 1
  fi
  sleep 1
done

echo "🧪 Running HTTP transport test with timeout protection..."
# Run the test with a timeout to prevent hanging
timeout 120 node tests/e2e/e2e_sse_mcp_client_test.mjs || {
    TEST_EXIT_CODE=$?
    if [ $TEST_EXIT_CODE -eq 124 ]; then
        echo "⚠️ HTTP transport test timed out after 120 seconds"
        exit 1
    else
        echo "❌ HTTP transport test failed with exit code: $TEST_EXIT_CODE"
        exit $TEST_EXIT_CODE
    fi
}

echo "🎉 HTTP transport test completed successfully!"