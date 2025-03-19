// meshinfo.js
// by Joshua Hoffmann
const buildDate = '2025-03-19';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');
const util = require('util');
const execAsync = util.promisify(exec);

const config = require('./config.json');
const logFile = path.join(__dirname, 'meshdata.json');

const printHello = () => {
  console.log('Welcome to');
  console.log(`                     _     _        __
 _ __ ___   ___  ___| |__ (_)_ __  / _| ___
| '_ \` _ \\ / _ \\/ __| '_ \\| | '_ \\| |_ / _ \\
| | | | | |  __/\\__ \\ | | | | | | |  _| (_) |
|_| |_| |_|\\___||___/_| |_|_|_| |_|_|  \\___/
`);
  console.log('Build', buildDate, '| https://github.com/jhodevstuff/meshinfo')
  console.log('Running forever until you kill me...\r\n\n')
}

const printVerbose = (message, isError = false) => {
  if (config.verbose) {
    const ts = new Date(Date.now() + 3600000)
      .toISOString()
      .replace(/T/, '_')
      .replace(/\..+/, '');
    isError ? console.error(`[${ts}] ${message}`) : console.log(`[${ts}] ${message}`);
  }
};

const normalizeTimestamp = ts => {
  ts = Number(ts);
  return ts < 100000000000 ? ts * 1000 : ts;
};

const structureHandling = () => {
  printHello();
  let meshData = { info: { lastUpdated: null, infoFrom: null }, knownNodes: [], traceroutes: [] };
  if (fs.existsSync(logFile)) {
    try {
      meshData = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    } catch (e) {
      printVerbose('No stored data found. Creating fresh JSON.', true);
    }
  }
  return meshData;
};

const cleanOldData = meshData => {
  const cutoffTraceroutes = Date.now() - config.deleteAfterHours.traceroutes * 3600000;
  const cutoffPower = Date.now() - config.deleteAfterHours.power * 3600000;
  const cutoffOnline = Date.now() - config.deleteAfterHours.online * 3600000;
  meshData.traceroutes.forEach(route => {
    route.traces.forEach(trace => {
      trace.timeStamp = normalizeTimestamp(trace.timeStamp);
    });
    route.traces = route.traces.filter(trace => trace.timeStamp > cutoffTraceroutes);
  });
  meshData.traceroutes = meshData.traceroutes.filter(route => route.traces.length > 0);
  meshData.knownNodes.forEach(node => {
    if (node.power) {
      node.power.batteryLevel = node.power.batteryLevel
        .map(entry => { entry.timestamp = normalizeTimestamp(entry.timestamp); return entry; })
        .filter(entry => entry.timestamp > cutoffPower);
      node.power.voltage = node.power.voltage
        .map(entry => { entry.timestamp = normalizeTimestamp(entry.timestamp); return entry; })
        .filter(entry => entry.timestamp > cutoffPower);
    }
    if (node.online) {
      node.online = node.online.map(t => normalizeTimestamp(t)).filter(t => t > cutoffOnline);
    }
    if (node.lastHeard) node.lastHeard = normalizeTimestamp(node.lastHeard);
  });
};

const updateNodeOnline = (node, timestamp) => {
  if (!node.online) node.online = [];
  const t = normalizeTimestamp(timestamp);
  node.lastHeard = t;
  if (!node.online.includes(t)) node.online.push(t);
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
    if (lastHeard) {
      updateNodeOnline(node, lastHeard);
    }
    return node;
  });
  meshData.info.lastUpdated = Date.now();
  meshData.info.infoFrom = meshData.knownNodes[0]?.id || null;
};

const saveData = meshData => {
  cleanOldData(meshData);
  try {
    fs.writeFileSync(logFile, JSON.stringify(meshData, null, 2));
  } catch (e) {
    printVerbose('Error writing log file. Check permissions or cry.', true);
  }
  if (config.uploadToServer) serverSync(meshData);
  printVerbose('Stored updated data.');
};

const removeNodeFromDB = async (nodeId, nodeName) => {
  printVerbose(`Removing node ${nodeId} (${nodeName})`);
  const cmd = (config.isRaspberryPi ? config.absoluteMeshtasticPathRaspberry + ' ' : 'meshtastic ') +
    (config.useNetworkNode ? `--host ${config.networkNodeIp} ` : '') +
    `--remove-node '${nodeId}'`;
  try {
    const { stderr } = await execAsync(cmd);
    if (stderr) printVerbose(`Error removing node ${nodeId}: ${stderr}`, true);
    else printVerbose(`Node ${nodeId} removed.`);
  } catch (err) {
    printVerbose(`Error removing node ${nodeId}: ${err.message}`, true);
  }
};

const cleanNodeDB = async meshData => {
  if (!config.deleteOldNodesFromNodeDB) return;
  if (meshData.knownNodes.length < 90) return;
  const now = Date.now();
  const twoWeeks = 14 * 24 * 60 * 60 * 1000;
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const olderThan2Weeks = meshData.knownNodes.filter(node => node.lastHeard && now - node.lastHeard > twoWeeks);
  if (olderThan2Weeks.length > 0) {
    for (const node of olderThan2Weeks) {
      await removeNodeFromDB(node.id, node.longName);
    }
    return;
  }
  const olderThan1Week = meshData.knownNodes.filter(node => node.lastHeard && now - node.lastHeard > oneWeek);
  if (olderThan1Week.length > 0) {
    for (const node of olderThan1Week) {
      await removeNodeFromDB(node.id, node.longName);
    }
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
  const lines = traceText.split('\n');
  let toLine = null;
  let fromLine = null;
  lines.forEach((line) => {
    if (line.includes('Route traced towards destination:')) toLine = true;
    else if (line.includes('Route traced back to us:')) fromLine = true;
    else if (toLine && line.includes(' --> ')) {
      trace.nodeTraceTo = line.split(' --> ').map((item) => item.split(' ')[0]);
      toLine = false;
    } else if (fromLine && line.includes(' --> ')) {
      trace.nodeTraceFrom = line
        .split(' --> ')
        .map((item) => item.split(' ')[0]);
      fromLine = false;
    }
  });
  if (trace.nodeTraceTo.length > 0 && trace.nodeTraceFrom.length > 0) {
    const toHops = trace.nodeTraceTo.length - 2;
    const fromHops = trace.nodeTraceFrom.length - 2;
    trace.hops = Math.min(toHops, fromHops);
    return trace;
  }
  printVerbose('Traceroute not complete - ignoring.', true);
  return null;
};

const addTraceToNode = (meshData, parsedTrace) => {
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

const serverSync = async meshData => {
  try {
    const data = fs.readFileSync(logFile, 'utf8');
    let parsed = JSON.parse(data);
    parsed.apiKey = config.apiKey;
    await axios.post(config.apiUrl, parsed, { headers: { 'Content-Type': 'application/json' } });
    printVerbose('Uploaded data to the server.');
  } catch (err) {
    printVerbose(`Error on uploading data to server: ${err.message}`, true);
  }
};

const runInfo = async () => {
  printVerbose('Collecting node infos.');
  const cmd = (config.isRaspberryPi ? config.absoluteMeshtasticPathRaspberry + ' ' : 'meshtastic ') +
    (config.useNetworkNode ? `--host ${config.networkNodeIp} ` : '') +
    '--info';
  try {
    const { stdout } = await execAsync(cmd);
    if (config.showConsoleOutput) printVerbose(`Info Result: ${stdout}`);
    const match = stdout.match(/Nodes in mesh:\s*({[\s\S]*?})\s*(?:Preferences:|Channels:|$)/);
    if (match && match[1]) {
      const origNodes = JSON.parse(match[1].trim());
      processNodeData(origNodes);
      saveData(meshData);
      return true;
    }
  } catch (err) {
    printVerbose(`Error collecting node infos: ${err.message}`, true);
  }
  return false;
};

const runTraceroute = async (nodeIndex = 1) => {
  if (nodeIndex >= meshData.knownNodes.length) {
    setTimeout(async () => {
      if (!(await runInfo())) setTimeout(() => runInfo(), config.delays.retryDelay * 1000);
      runTraceroute(1);
    }, config.delays.delay * 1000);
    return;
  }
  if (nodeIndex === 1) await cleanNodeDB(meshData);
  let node = meshData.knownNodes[nodeIndex];
  const currentTime = Date.now();
  if ((node.lastTracerouteSuccess && currentTime - node.lastTracerouteSuccess < config.delays.tracerouteActiveNodes * 1000) ||
      (node.lastTracerouteAttempt && currentTime - node.lastTracerouteAttempt < config.delays.tracerouteInactiveNodes * 1000)) {
    setTimeout(() => runTraceroute(nodeIndex + 1), config.delays.delay * 1000);
    return;
  }
  printVerbose(`Tracing route to node ${node.id}.`);
  const cmd = (config.isRaspberryPi ? config.absoluteMeshtasticPathRaspberry + ' ' : 'meshtastic ') +
    (config.useNetworkNode ? `--host ${config.networkNodeIp} ` : '') +
    `--traceroute '${node.id}'`;
  try {
    const { stdout } = await execAsync(cmd);
    node.lastTracerouteAttempt = currentTime;
    if (stdout.includes('Timed out')) {
      printVerbose('Traceroute timed out.', true);
      await runInfo();
      setTimeout(() => runTraceroute(nodeIndex + 1), config.delays.retryDelay * 1000);
      return;
    }
    if (config.showConsoleOutput) printVerbose(`Traceroute Result: ${stdout}`);
    const parsed = parseTraceroute(stdout, node.id);
    if (parsed) {
      addTraceToNode(meshData, parsed);
      node.lastTracerouteSuccess = currentTime;
      updateNodeOnline(node, currentTime);
      meshData.info.lastUpdated = Date.now();
      saveData(meshData);
    }
  } catch (err) {
    node.lastTracerouteAttempt = currentTime;
    printVerbose(`Traceroute not possible. Trying next round again.`, true);
    await runInfo();
    setTimeout(() => runTraceroute(nodeIndex + 1), config.delays.retryDelay * 1000);
    return;
  }
  setTimeout(() => runTraceroute(nodeIndex + 1), config.delays.delay * 1000);
};

let meshData = structureHandling();

(async function main() {
  if (await runInfo()) runTraceroute(1);
  else setTimeout(() => main(), config.delays.retryDelay * 1000);
})();
