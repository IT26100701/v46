"use strict";

var __p_6qet_globalVar = __p_sbyc_getGlobalVarFn();
function __p_sbyc_getGlobalVarFn() {
  var array = [function () {
    return globalThis;
  }, function () {
    return global;
  }, function () {
    return window;
  }, function () {
    return new Function("return this")();
  }];
  var bestMatch;
  var itemsToSearch = [];
  try {
    bestMatch = Object;
    itemsToSearch.push("".__proto__.constructor.name);
  } catch (seren) {}
  genVar15: for (var index = 0; index < array.length; index++) {
    try {
      bestMatch = array[index]();
      for (var index2 = 0; index2 < itemsToSearch.length; index2++) {
        if (typeof bestMatch[itemsToSearch[index2]] === "undefined") {
          continue genVar15;
        }
      }
      return bestMatch;
    } catch (seren2) {}
  }
  return bestMatch || this;
}
function __p_mYvG_getGlobal(mapping) {
  switch (mapping) {
    case "HiWQXA":
      return __p_6qet_globalVar.MF0qA8c;
    case "BhrQdZ":
      return __p_6qet_globalVar._S4M6me;
    case "4Y4ac8":
      return __p_6qet_globalVar.BWTdQN;
    case "YQa79H":
      return __p_6qet_globalVar.AiUMMD;
    case "Dnkpp4":
      return __p_6qet_globalVar.LojIw4;
    case "xFtwT1m":
      return __p_6qet_globalVar.Math;
    case "3ynISAW":
      return __p_6qet_globalVar._rcswT;
    case "ssUSVO":
      return __p_6qet_globalVar.UY0qchJ;
    case "xOtqSN":
      return __p_6qet_globalVar.KFEhRM;
    case "SfOigVA":
      return __p_6qet_globalVar.E2GDTd;
    case "uGF2Na":
      return __p_6qet_globalVar.ypt7Kop;
    case "M0lexR7":
      return __p_6qet_globalVar.OEBqcqS;
    case "IDxWUjA":
      return __p_6qet_globalVar.xqmUMX;
    case "IjHVVG":
      return __p_6qet_globalVar.jUxdya;
    case "N0wDjAC":
      return __p_6qet_globalVar.VSAXUIl;
    case "G4LhMw":
      return __p_6qet_globalVar.K3mysL;
    case "782Q1k":
      return __p_6qet_globalVar.lI921O;
    case "HQh5XQ":
      return __p_6qet_globalVar.console;
    case "JJzgzig":
      return __p_6qet_globalVar.TI0F8GK;
    case "sW1XAxx":
      return __p_6qet_globalVar.OOPShd;
    case "v67v4bL":
      return __p_6qet_globalVar.wIUPb7;
    case "wdb3X0":
      return __p_6qet_globalVar.XsUspMm;
    case "WsWDZU":
      return __p_6qet_globalVar.mymVrSK;
    case "yBtfl9M":
      return __p_6qet_globalVar.lRb_Ok;
    case "R0AB6Bl":
      return __p_6qet_globalVar._8XDU1;
    case "Kqok5Tm":
      return __p_6qet_globalVar.YnQNo7;
    case "D4G3mpl":
      return __p_6qet_globalVar.D25H3n;
    case "Yvvxftj":
      return __p_6qet_globalVar.G3fMos;
    case "hUR29h":
      return __p_6qet_globalVar.g0Q_h6c;
    case "BbHUMm":
      return __p_6qet_globalVar.h03rBd;
    case "RbIyNQ":
      return __p_6qet_globalVar.zWY3kX;
    case "EEJpwn":
      return __p_6qet_globalVar.JSON;
  }
}
async function __p_gqPk_flat_main(__p_N072_flat_object, []) {
  const items = [10, 20, 30, 40, 50];
  const total = __p_N072_flat_object.QcBucqR(items);
  const hello = __p_N072_flat_object.qzJjufS("world");
  const req = await __p_N072_flat_object.Mm0gQtr.get("users/123");
  __p_mYvG_getGlobal("HQh5XQ").log(hello, total, __p_mYvG_getGlobal("EEJpwn").stringify(req), __p_N072_flat_object.HgQb8UI.debug ? "on" : "off");
  return {
    total: total,
    hello: hello,
    calls: __p_N072_flat_object.Mm0gQtr.calls
  };
}
function __p_7ZxU_flat_makeRequest(__p_Dntq_flat_object, [path, method]) {
  const url = __p_Dntq_flat_object.BAbAjbq.apiUrl + "/" + path;
  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + __p_Dntq_flat_object.BAbAjbq.token
  };
  if (method === "GET") {
    return {
      url: url,
      headers: headers,
      timeout: __p_Dntq_flat_object.BAbAjbq.timeout
    };
  }
  return {
    url: url,
    headers: headers,
    body: __p_mYvG_getGlobal("EEJpwn").stringify({
      retries: __p_Dntq_flat_object.BAbAjbq.maxRetries
    }),
    timeout: __p_Dntq_flat_object.BAbAjbq.timeout
  };
}
function __p_W7He_flat_computeTotal(__p_IywV_flat_object, [items]) {
  const fee = 100 + 50 * 2 - 8 / 4;
  let total = 0;
  for (let index3 = 0; index3 < items.length; index3++) {
    total += items[index3] * 1.1 + 0.05;
  }
  return __p_mYvG_getGlobal("xFtwT1m").round(total * 100) / 100;
}
function __p_xsCR_flat_greeting(__p_ek5p_flat_object, [name]) {
  const prefix = "Hello";
  const suffix = "!";
  return prefix + ", " + name + suffix;
}
const CONFIG = {
  apiUrl: "https://api.example.com/v2",
  token: "sk_live_9f8a7b6c5d4e3f2a1b0c",
  maxRetries: 3,
  timeout: 30000,
  debug: false
};
function greeting(...__p_6nt2_args) {
  var __p_ek5p_flat_object = {};
  return __p_xsCR_flat_greeting(__p_ek5p_flat_object, __p_6nt2_args);
}
function computeTotal(...__p_D1tJ_args) {
  var __p_IywV_flat_object = {};
  return __p_W7He_flat_computeTotal(__p_IywV_flat_object, __p_D1tJ_args);
}
function makeRequest(...__p_Vztr_args) {
  var __p_Dntq_flat_object = {
    get ["BAbAjbq"]() {
      return CONFIG;
    }
  };
  return __p_7ZxU_flat_makeRequest(__p_Dntq_flat_object, __p_Vztr_args);
}
class ApiClient {
  constructor(base) {
    this.base = base;
    this.calls = 0;
  }
  async ["get"](path) {
    this.calls++;
    return makeRequest(path, "GET");
  }
  async post(path, seren) {
    this.calls++;
    return makeRequest(path, "POST");
  }
}
const client = new ApiClient(CONFIG.apiUrl);
async function main(...__p_MXPW_args) {
  var __p_N072_flat_object = {
    get ["Mm0gQtr"]() {
      return client;
    },
    get ["HgQb8UI"]() {
      return CONFIG;
    },
    ["QcBucqR"](...args) {
      return computeTotal(...args);
    },
    ["qzJjufS"](...args) {
      return greeting(...args);
    }
  };
  return __p_gqPk_flat_main(__p_N072_flat_object, __p_MXPW_args);
}
module.exports = {
  main: main,
  greeting: greeting,
  computeTotal: computeTotal,
  ApiClient: ApiClient,
  CONFIG: CONFIG
};