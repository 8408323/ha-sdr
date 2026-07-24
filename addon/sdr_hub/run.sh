#!/usr/bin/with-contenv bashio
set -e

export LOG_LEVEL=$(bashio::config 'log_level')
export API_TOKEN=$(bashio::config 'api_token')

cd /app
exec uvicorn main:app --host 0.0.0.0 --port 8765
