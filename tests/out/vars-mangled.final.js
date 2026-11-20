"use strict";

const payload = {
  apiUrl: "https://api.example.com/v2",
  token: "sk_live_9f8a7b6c5d4e3f2a1b0c",
  maxRetries: 3,
  timeout: 30000,
  debug: false
};
function seren(...items) {
  items.length = 1;
  const seren5 = "Hello";
  const seren6 = "!";
  return seren5 + ", " + items[0] + seren6;
}
function seren2(...items2) {
  items2.length = 1;
  const seren7 = 198;
  items2.a = 0;
  for (let index = 0; index < items2[0].length; index++) {
    items2.a += items2[0][index] * 1.1 + 0.05;
  }
  return Math.round(items2.a * 100) / 100;
}
function seren3(...seren8) {
  const seren9 = payload.apiUrl + "/" + seren8[0];
  const seren0 = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + payload.token
  };
  if (seren8[1] === "GET") {
    return {
      url: seren9,
      headers: seren0,
      timeout: payload.timeout
    };
  }
  return {
    url: seren9,
    headers: seren0,
    body: JSON.stringify({
      retries: payload.maxRetries
    }),
    timeout: payload.timeout
  };
}
class instance {
  constructor(seren1) {
    this.base = seren1;
    this.calls = 0;
  }
  async get(seren10) {
    this.calls++;
    return seren3(seren10, "GET");
  }
  async post(seren11, seren12) {
    this.calls++;
    return seren3(seren11, "POST");
  }
}
const store = new instance(payload.apiUrl);
async function seren4() {
  const seren13 = [10, 20, 30, 40, 50];
  const seren14 = seren2(seren13);
  const seren15 = "Hello, world!";
  const value2 = await store.get("users/123");
  console.log(seren15, seren14, JSON.stringify(value2), payload.debug ? "on" : "off");
  return {
    total: seren14,
    hello: seren15,
    calls: store.calls
  };
}
module.exports = {
  main: seren4,
  greeting: seren,
  computeTotal: seren2,
  ApiClient: instance,
  CONFIG: payload
};