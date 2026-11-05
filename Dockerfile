FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000 DB_PATH=/app/data/heliowatt.db
VOLUME /app/data
EXPOSE 3000
# ADMIN_PASSWORD must be passed at run time, for example: docker run -e ADMIN_PASSWORD=... -p 3000:3000 -v hw-data:/app/data heliowatt
CMD ["node", "--no-warnings", "server.js"]
