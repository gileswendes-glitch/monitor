FROM node:18-alpine

# Install tools needed for pinging
RUN apk add --no-cache iputils

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD [ "node", "server.js" ]