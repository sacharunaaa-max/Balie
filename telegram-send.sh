#!/bin/bash
# Send message via @UmaBobot Telegram bot
# Usage: ./telegram-send.sh "message text" [chat_id]
# Default chat_id is Bo's

BOT_TOKEN="8745894275:AAEljk6ouwRo_cazAxN5ViMkRCQrd1xyZV8"
CHAT_ID="${2:-34692862394}"
MESSAGE="$1"

curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -d "chat_id=${CHAT_ID}&text=${MESSAGE}&parse_mode=Markdown" > /dev/null

echo "Telegram sent to $CHAT_ID: ${MESSAGE:0:50}..."
