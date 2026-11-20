"use strict";

const CONFIG = {
  apiUrl: "https://api.example.com/v2",
  token: "sk_live_9f8a7b6c5d4e3f2a1b0c",
  maxRetries: 3,
  timeout: 30000,
  debug: false
};
function greeting(name) {
  const prefix = "Hello";
  const suffix = "!";
  return prefix + ", " + name + suffix;
}
function computeTotal(items) {
  const fee = 100 + 50 * 2 - 8 / 4;
  let total = 0;
  for (let index = 0; index < items.length; index++) {
    total += items[index] * 1.1 + 0.05;
  }
  return Math.round(total * 100) / 100;
}
function makeRequest(path, method) {
  const url = CONFIG.apiUrl + "/" + path;
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + CONFIG.token
  };
  if (method === "GET") {
    return {
      url: url,
      headers: headers,
      timeout: CONFIG.timeout
    };
  }
  return {
    url: url,
    headers: headers,
    body: JSON.stringify({
      retries: CONFIG.maxRetries
    }),
    timeout: CONFIG.timeout
  };
}
class ApiClient {
  constructor(base) {
    this.base = base;
    this.calls = 0;
  }
  async get(path) {
    this.calls++;
    return makeRequest(path, "GET");
  }
  async post(path, seren) {
    this.calls++;
    return makeRequest(path, "POST");
  }
}
const client = new ApiClient(CONFIG.apiUrl);
async function main() {
  const items = [10, 20, 30, 40, 50];
  const total = computeTotal(items);
  const hello = "Hello, world!";
  const req = await client.get("users/123");
  console.log(hello, total, JSON.stringify(req), CONFIG.debug ? "on" : "off");
  return {
    total: total,
    hello: hello,
    calls: client.calls
  };
}
module.exports = {
  main: main,
  greeting: greeting,
  computeTotal: computeTotal,
  ApiClient: ApiClient,
  CONFIG: CONFIG
};