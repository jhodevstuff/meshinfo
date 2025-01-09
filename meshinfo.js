// 2025-01-09 by Joshua Hoffmann

const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const axios = require("axios");
const config = require("./config.json");
let meshData = {
  info: { lastUpdated: null, infoFrom: null },
  knownNodes: [],
  traceroutes: [],
};
let currentNodeIndex = 1;
const logFile = path.join(__dirname, "meshdata.json");

const printVerbose = (message, error) => {
  if (config.verbose) {
    const timestamp = new Date(new Date().getTime() + 3600000)
      .toISOString()
      .replace(/T/, "_")
      .replace(/\..+/, "")
      .replace(/-/g, "-")
      .replace(/:/g, ":");
    if (error) {
      console.error(`[${timestamp}] ${message}`);
    } else {
      console.log(`[${timestamp}] ${message}`);
    }
  }
};

const structureHandling = () => {
  if (fs.existsSync(logFile)) {
    const fileContent = fs.readFileSync(logFile, "utf8");
    try {
      meshData = JSON.parse(fileContent);
    } catch (error) {
      meshData = {
        info: { lastUpdated: null, infoFrom: null },
        knownNodes: [],
        traceroutes: [],
      };
    }
  }
};

const normalizeTimestamp = (ts) => {
  ts = Number(ts);
  return ts < 100000000000 ? ts * 1000 : ts;
}

const cleanOldData = () => {
  const cutoffTimeTraceroutes = Date.now() - config.deleteAfterHours.traceroutes * 3600000;
  const cutoffTimePower = Date.now() - config.deleteAfterHours.power * 3600000;
  const cutoffTimeOnline = Date.now() - config.deleteAfterHours.online * 3600000;
  meshData.traceroutes.forEach((route) => {
    route.traces.forEach((trace) => {
      trace.timeStamp = normalizeTimestamp(trace.timeStamp);
    });
    route.traces = route.traces.filter((trace) => trace.timeStamp > cutoffTimeTraceroutes);
  });
  meshData.traceroutes = meshData.traceroutes.filter(
    (route) => route.traces.length > 0
  );
  meshData.knownNodes.forEach((node) => {
    if (node.power) {
      node.power.batteryLevel = node.power.batteryLevel
        .map((entry) => {
          entry.timestamp = normalizeTimestamp(entry.timestamp);
          return entry;
        })
        .filter((entry) => entry.timestamp > cutoffTimePower);
      node.power.voltage = node.power.voltage
        .map((entry) => {
          entry.timestamp = normalizeTimestamp(entry.timestamp);
          return entry;
        })
        .filter((entry) => entry.timestamp > cutoffTimePower);
    }
    if (node.online) {
      node.online = node.online
        .map((t) => normalizeTimestamp(t))
        .filter((t) => t > cutoffTimeOnline);
    }
    if (node.lastHeard) {
      node.lastHeard = normalizeTimestamp(node.lastHeard);
    }
  });
}

const updateNodeOnline = (node, newTimestamp) => {
  if (!node.online) node.online = [];
  const normalized = normalizeTimestamp(newTimestamp);
  node.lastHeard = normalized;
  if (!node.online.includes(normalized)) {
    node.online.push(normalized);
  }
}

const saveData = () => {
  cleanOldData();
  fs.writeFileSync(logFile, JSON.stringify(meshData, null, 2));
  if (config.uploadToServer) {
    serverSync();
  }
  printVerbose("Data updated");
};

const runInfo = (retryAfterFailure = true) => {
  printVerbose("Loading Nodes infos");
  exec(
    (config.isRaspberryPi
      ? config.absoluteMeshtasticPathRaspberry + " "
      : "meshtastic ") +
      (config.useNetworkNode ? `--host ${config.networkNodeIp} ` : "") +
      "--info",
    (error, stdout) => {
      if (error) {
        printVerbose(`Info Error: ${error.message}`, true);
        if (retryAfterFailure) {
          printVerbose(`Retrying in ${config.delays.retryDelay} seconds...`);
          setTimeout(
            () => runInfo(retryAfterFailure),
            config.delays.retryDelay * 1000
          );
        }
        return;
      }
      if (config.showConsoleOutput) printVerbose(`Info Result: ${stdout}`);
      const nodesMatch = stdout.match(
        /Nodes in mesh:\s*({[\s\S]*?})\s*(?:Preferences:|Channels:|$)/
      );
      if (nodesMatch && nodesMatch[1]) {
        try {
          processNodeData(JSON.parse(nodesMatch[1].trim()));
          saveData();
          if (retryAfterFailure) {
            currentNodeIndex = 1;
            runTraceroute();
          }
        } catch (parseError) {
          printVerbose(`JSON Parsing Error: ${parseError.message}`, true);
          if (retryAfterFailure)
            setTimeout(
              () => runInfo(retryAfterFailure),
              config.delays.retryDelay * 1000
            );
        }
      }
    }
  );
};

const processNodeData = (origNodes) => {
  meshData.knownNodes = Object.keys(origNodes).map((nodeId) => {
    const nodeData = origNodes[nodeId];
    const knownNode = meshData.knownNodes.find((n) => n.id === nodeId);
    const lastHeard = nodeData.lastHeard || null;
    const batteryLevel = nodeData.deviceMetrics?.batteryLevel ?? null;
    const voltage = nodeData.deviceMetrics?.voltage ?? null;
    const powerHistory = knownNode?.power || { batteryLevel: [], voltage: [] };
    if (
      batteryLevel !== null &&
      batteryLevel !== undefined &&
      batteryLevel !== knownNode?.batteryLevel
    ) {
      powerHistory.batteryLevel.push({
        state: batteryLevel,
        timestamp: Date.now(),
      });
    }
    if (
      voltage !== null &&
      voltage !== undefined &&
      voltage !== knownNode?.voltage
    ) {
      powerHistory.voltage.push({ state: voltage, timestamp: Date.now() });
    }
    const node = {
      id: nodeId,
      longName: nodeData.user.longName || null,
      shortName: nodeData.user.shortName || null,
      model: nodeData.user.hwModel || null,
      lastHeard: knownNode?.lastHeard || null,
      batteryLevel: batteryLevel,
      voltage: voltage,
      power: powerHistory,
      snr: nodeData.snr || null,
      hops: nodeData.hopsAway || 0,
      uptimeSeconds: nodeData.deviceMetrics?.uptimeSeconds || null,
      lat: nodeData.position?.latitude || null,
      lon: nodeData.position?.longitude || null,
      publicKey: nodeData.user.publicKey || null,
      lastTracerouteSuccess: knownNode?.lastTracerouteSuccess || null,
      lastTracerouteAttempt: knownNode?.lastTracerouteAttempt || null,
      online: knownNode?.online || [],
    };
    // const fixLivingInTheFuture = (timestamp) => {
    //   const currentTime = Date.now();
    //   const oneDayMs = 365 * 24 * 60 * 60 * 1000;
    //   if (timestamp > currentTime + oneDayMs) {
    //     return currentTime;
    //   }
    //   return timestamp;
    // }
    if (lastHeard) {
      // node.lastHeard = fixLivingInTheFuture(node.lastHeard);
      updateNodeOnline(node, lastHeard);
    }
    return node;
  });
  meshData.info.lastUpdated = Date.now();
  meshData.info.infoFrom = meshData.knownNodes[0]?.id || null;
};

const runTraceroute = () => {
  if (currentNodeIndex >= meshData.knownNodes.length) {
    setTimeout(runInfo, config.delays.delay * 1000);
    return;
  }
  const node = meshData.knownNodes[currentNodeIndex];
  const currentTime = Date.now();
  if (
    (node.lastTracerouteSuccess &&
      currentTime - node.lastTracerouteSuccess <
        config.delays.tracerouteActiveNodes * 1000) ||
    (node.lastTracerouteAttempt &&
      currentTime - node.lastTracerouteAttempt <
        config.delays.tracerouteInactiveNodes * 1000)
  ) {
    currentNodeIndex++;
    setTimeout(runTraceroute, config.delays.delay * 1000);
    return;
  }
  printVerbose(`Traceroute to Node ${node.id}`);
  exec(
    (config.isRaspberryPi
      ? config.absoluteMeshtasticPathRaspberry + " "
      : "meshtastic ") +
      (config.useNetworkNode ? `--host ${config.networkNodeIp} ` : "") +
      `--traceroute '${node.id}'`,
    (error, stdout) => {
      node.lastTracerouteAttempt = currentTime;
      if (error || stdout.includes("Timed out")) {
        printVerbose(`Traceroute Error: ${error?.message || "Timed out"}`, true);
        runInfo(false);
        setTimeout(() => {
          currentNodeIndex++;
          runTraceroute();
        }, config.delays.retryDelay * 1000);
        return;
      }
      if (config.showConsoleOutput)
        printVerbose(`Traceroute Result: ${stdout}`);
      const parsedTrace = parseTraceroute(stdout, node.id);
      if (parsedTrace) {
        addTraceToNode(parsedTrace);
        node.lastTracerouteSuccess = currentTime;
        updateNodeOnline(node, currentTime);
        meshData.info.lastUpdated = Date.now();
        saveData();
      }
      currentNodeIndex++;
      setTimeout(runTraceroute, config.delays.delay * 1000);
    }
  );
};

const addTraceToNode = (parsedTrace) => {
  let nodeTraceroute = meshData.traceroutes.find(
    (route) => route.nodeId === parsedTrace.nodeId
  );
  if (nodeTraceroute) {
    nodeTraceroute.traces.push(parsedTrace);
  } else {
    nodeTraceroute = { nodeId: parsedTrace.nodeId, traces: [parsedTrace] };
    meshData.traceroutes.push(nodeTraceroute);
  }
};

const parseTraceroute = (traceText, nodeId) => {
  const trace = {
    nodeId,
    timeStamp: Date.now(),
    nodeTraceTo: [],
    nodeTraceFrom: [],
    hops: -1,
  };
  const lines = traceText.split("\n");
  let toLine = null;
  let fromLine = null;
  lines.forEach((line) => {
    if (line.includes("Route traced towards destination:")) toLine = true;
    else if (line.includes("Route traced back to us:")) fromLine = true;
    else if (toLine && line.includes(" --> ")) {
      trace.nodeTraceTo = line.split(" --> ").map((item) => item.split(" ")[0]);
      toLine = false;
    } else if (fromLine && line.includes(" --> ")) {
      trace.nodeTraceFrom = line
        .split(" --> ")
        .map((item) => item.split(" ")[0]);
      fromLine = false;
    }
  });
  if (trace.nodeTraceTo.length > 0 && trace.nodeTraceFrom.length > 0) {
    const toHops = trace.nodeTraceTo.length - 2;
    const fromHops = trace.nodeTraceFrom.length - 2;
    trace.hops = Math.min(toHops, fromHops);
    return trace;
  }
  printVerbose("Traceroute not complete - ignoring.", true);
  return null;
};

const serverSync = async () => {
  if (!config.uploadToServer) return;
  try {
    const jsonData = fs.readFileSync(logFile, "utf8");
    const parsedData = JSON.parse(jsonData);
    parsedData.apiKey = config.apiKey;
    await axios.post(config.apiUrl, parsedData, {
      headers: {
        "Content-Type": "application/json",
      },
    });
    printVerbose("Updated data on server");
  } catch (error) {
    printVerbose(`API Error: ${error.message}`, true);
  }
};

structureHandling();
runInfo();
