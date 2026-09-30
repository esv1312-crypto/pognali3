FROM python:3.12-slim

WORKDIR /app

COPY chatgpt/mcp/requirements.txt /app/chatgpt/mcp/requirements.txt
RUN pip install --no-cache-dir -r /app/chatgpt/mcp/requirements.txt

COPY chatgpt /app/chatgpt

ENV PYTHONUNBUFFERED=1
ENV PORT=8000

EXPOSE 8000

CMD ["python", "chatgpt/mcp/server.py"]
