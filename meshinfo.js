// 2024-11-14 by Joshua Hoffmann

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

const printVerbose = (message) => {
  if (config.verbose) {
    const timestamp = new Date(new Date().getTime() + 3600000)
      .toISOString()
      .replace(/T/, "_")
      .replace(/\..+/, "")
      .replace(/-/g, "-")
      .replace(/:/g, ":");
    console.log(`[${timestamp}] ${message}`);
  }
};

const printError = (message) => {
  const timestamp = new Date(new Date().getTime() + 3600000)
    .toISOString()
    .replace(/T/, "_")
    .replace(/\..+/, "")
    .replace(/-/g, "-")
    .replace(/:/g, ":");
  console.error(`[${timestamp}] ${message}`);
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

const saveData = () => {
  cleanOldTraceroutes();
  cleanOldPowerHistory();
  fs.writeFileSync(logFile, JSON.stringify(meshData, null, 2));
  if (config.uploadToServer) {
    serverSync();
  }
  printVerbose("Data updated");
};

const cleanOldTraceroutes = () => {
  const cutoffTime = Date.now() - config.delays.cleanOldTraceroutes * 1000;
  meshData.traceroutes = meshData.traceroutes.filter((route) => {
    route.traces = route.traces.filter((trace) => trace.timeStamp > cutoffTime);
    return route.traces.length > 0;
  });
};

const cleanOldPowerHistory = () => {
  const cutoffTime = Date.now() - config.delays.cleanOldTraceroutes * 1000;
  meshData.knownNodes.forEach((node) => {
    if (node.power) {
      node.power.batteryLevel = node.power.batteryLevel.filter(
        (entry) => entry.timestamp > cutoffTime
      );
      node.power.voltage = node.power.voltage.filter(
        (entry) => entry.timestamp > cutoffTime
      );
    }
  });
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
        printError(`Info Error: ${error.message}`);
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
          printError(`JSON Parsing Error: ${parseError.message}`);
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
    if (knownNode && knownNode.lastHeard !== lastHeard) {
      knownNode.lastHeard = lastHeard;
      knownNode.lastTracerouteAttempt = null;
    }
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
    return {
      id: nodeId,
      longName: nodeData.user.longName || null,
      shortName: nodeData.user.shortName || null,
      model: nodeData.user.hwModel || null,
      lastHeard: lastHeard,
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
    };
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
        printError(`Traceroute Error: ${error?.message || "Timed out"}`);
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
    if (line.includes("Route traced towards destination:")) {
      toLine = true;
    } else if (line.includes("Route traced back to us:")) {
      fromLine = true;
    } else if (toLine && line.includes(" --> ")) {
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
  printError("Traceroute not complete - ignoring.");
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
    printError(`API Error: ${error.message}`);
  }
};

structureHandling();
runInfo();
