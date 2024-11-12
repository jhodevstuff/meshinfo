// 2024-11-10 by Joshua Hoffmann

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

let meshData = {
  info: { lastUpdated: null, infoFrom: null },
  knownNodes: [],
  traceroutes: [],
};
let currentNodeIndex = 1;

const apiUrl = 'https://example.com/updatelog.php';
const logFile = path.join(__dirname, 'meshdata.json');
const delay = 5000;
const retryDelay = 10000;
const apiKey = 'api-key';
const piMeshLoc = '/home/jho/.local/bin/meshtastic ';
const showStdout = true;
const networkNode = '--host 192.168.178.114 ';
const isRaspberryPi = false;
const useNetworkNode = true;

const structureHandling = () => {
  if (fs.existsSync(logFile)) {
    const fileContent = fs.readFileSync(logFile, 'utf8');
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
  fs.writeFileSync(logFile, JSON.stringify(meshData, null, 2));
  serverSync();
  console.log('Data updated');
};

const runInfo = () => {
  console.log('Loading Nodes infos');
  exec(
    isRaspberryPi
      ? piMeshLoc
      : 'meshtastic ' + (useNetworkNode ? networkNode : '') + '--info',
    (error, stdout) => {
      if (error) {
        console.error(`Info Error: ${error.message}`);
        console.log(`Retrying in ${retryDelay / 1000} seconds...`);
        setTimeout(runInfo, retryDelay);
        return;
      }
      if (showStdout) console.log('Info Result:', stdout);
      const nodesMatch = stdout.match(
        /Nodes in mesh:\s*({[\s\S]*?})\s*(?:Preferences:|Channels:|$)/
      );
      if (nodesMatch && nodesMatch[1]) {
        let nodesBlock = nodesMatch[1].trim();
        try {
          const origNodes = JSON.parse(nodesBlock);
          meshData.knownNodes = Object.keys(origNodes).map((nodeId) => {
            const nodeData = origNodes[nodeId];
            const knownNode = meshData.knownNodes.find((n) => n.id === nodeId);
            const lastHeard = nodeData.lastHeard || null;
            if (knownNode && knownNode.lastHeard !== lastHeard) {
              knownNode.lastHeard = lastHeard;
              knownNode.lastTracerouteAttempt = null;
            }
            return {
              id: nodeId,
              longName: nodeData.user.longName || null,
              shortName: nodeData.user.shortName || null,
              model: nodeData.user.hwModel || null,
              lastHeard: lastHeard,
              batteryLevel: nodeData.deviceMetrics?.batteryLevel || null,
              voltage: nodeData.deviceMetrics?.voltage || null,
              snr: nodeData.snr || null,
              uptimeSeconds: nodeData.deviceMetrics?.uptimeSeconds || null,
              lat: nodeData.position?.latitude || null,
              lon: nodeData.position?.longitude || null,
              publicKey: nodeData.user.publicKey || null,
              lastTracerouteSuccess: knownNode?.lastTracerouteSuccess || null,
              lastTracerouteAttempt: knownNode?.lastTracerouteAttempt || null,
            };
          });
          meshData.info.lastUpdated = Date.now();
          meshData.info.infoFrom = meshData.knownNodes[0].id;
          saveData();
          currentNodeIndex = 1;
          runTraceroute();
        } catch (parseError) {
          setTimeout(runInfo, retryDelay);
        }
      }
    }
  );
};

const runTraceroute = () => {
  if (currentNodeIndex >= meshData.knownNodes.length) {
    setTimeout(runInfo, delay);
    return;
  }
  const node = meshData.knownNodes[currentNodeIndex];
  const currentTime = Date.now();
  if (
    (node.lastTracerouteSuccess &&
      currentTime - node.lastTracerouteSuccess < 1800000) || // 0.5h
    (node.lastTracerouteAttempt &&
      currentTime - node.lastTracerouteAttempt < 3600000) // 1h
  ) {
    currentNodeIndex++;
    setTimeout(runTraceroute, delay);
    return;
  }
  console.log(`Traceroute to Node ${node.id}`);
  exec(
    isRaspberryPi ? piMeshLoc : 'meshtastic ' +
      (useNetworkNode ? networkNode : '') +
      "--traceroute '" +
      node.id +
      "'",
    (error, stdout) => {
      node.lastTracerouteAttempt = currentTime;
      if (error || stdout.includes('Timed out')) {
        currentNodeIndex++;
        setTimeout(runTraceroute, retryDelay);
        return;
      }
      if (showStdout) console.log('Traceroute Result:', stdout);
      const parsedTrace = parseTraceroute(stdout, node.id);
      if (parsedTrace) {
        addTraceToNode(parsedTrace);
        node.lastTracerouteSuccess = currentTime;
        meshData.info.lastUpdated = Date.now();
        saveData();
      }
      currentNodeIndex++;
      setTimeout(runTraceroute, delay);
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
  const lines = traceText.split('\n');
  let toLine = null;
  let fromLine = null;
  lines.forEach((line) => {
    if (line.includes('Route traced towards destination:')) {
      toLine = true;
    } else if (line.includes('Route traced back to us:')) {
      fromLine = true;
    } else if (toLine && line.includes(' --> ')) {
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
  console.error('Traceroute not complete - ignoring.');
  return null;
};

const serverSync = async () => {
  try {
    const jsonData = fs.readFileSync(logFile, 'utf8');
    const parsedData = JSON.parse(jsonData);
    parsedData.apiKey = apiKey;
    await axios.post(apiUrl, parsedData, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    console.log('Updated data on server');
  } catch (error) {
    console.error(`API Error: ${error.message}`);
  }
};

structureHandling();
runInfo();
