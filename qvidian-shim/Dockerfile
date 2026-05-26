FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install
COPY src ./src
ENV PORT=${PORT:-3010}
EXPOSE 3010
CMD ["node","/app/src/index.js"]
