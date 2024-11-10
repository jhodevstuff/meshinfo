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
const delay = 1000;
const apiKey = 'api-key';
const showStdout = false;
const networkNode = '--host 192.168.178.114 ';
const useNetworkNode = false;

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
  } else {
    meshData = {
      info: { lastUpdated: null, infoFrom: null },
      knownNodes: [],
      traceroutes: [],
    };
  }
};

const saveData = () => {
  fs.writeFileSync(logFile, JSON.stringify(meshData, null, 2));
  serverSync();
  console.log('Data updated');
};

const runInfo = () => {
  console.log('Loading Nodes infos')
  exec(
    'meshtastic ' + (useNetworkNode ? networkNode : '') + '--info',
    (error, stdout) => {
      if (error) {
        console.error(`Info Error: ${error.message}`);
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
          meshData.knownNodes = Object.keys(origNodes).map((nodeId) => ({
            id: nodeId,
            longName: origNodes[nodeId].user.longName || null,
            shortName: origNodes[nodeId].user.shortName || null,
            model: origNodes[nodeId].user.hwModel || null,
            lastHeard: origNodes[nodeId].lastHeard || null,
            batteryLevel: origNodes[nodeId].deviceMetrics?.batteryLevel || null,
            uptimeSeconds:
              origNodes[nodeId].deviceMetrics?.uptimeSeconds || null,
            publicKey: origNodes[nodeId].user.publicKey || null,
          }));
          meshData.info.infoFrom = meshData.knownNodes[0].id;
          console.log(
            'Using connected Node',
            meshData.info.infoFrom,
            'for this'
          );
          saveData();
          currentNodeIndex = 1;
          runTraceroute();
        } catch (parseError) {
          console.error('Error parsing Nodes info block', parseError.message);
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
  const nodeId = meshData.knownNodes[currentNodeIndex].id;
  console.log(`Running traceroute to Node ${nodeId}`);
  exec(
    "meshtastic " +
      (useNetworkNode ? networkNode : "") +
      "--traceroute '" +
      nodeId +
      "'",
    (error, stdout) => {
      if (error || stdout.includes('Timed out')) {
        currentNodeIndex++;
        setTimeout(runTraceroute, delay);
        return;
      }
      if (showStdout) console.log('Traceroute Result:', stdout);
      const parsedTrace = parseTraceroute(stdout, nodeId);
      if (parsedTrace) {
        addTraceToNode(parsedTrace);
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
  const node = meshData.knownNodes.find(
    (node) => node.id === parsedTrace.nodeId
  );
  if (node && (!node.lastHeard || parsedTrace.timeStamp > node.lastHeard)) {
    node.lastHeard = parsedTrace.timeStamp;
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
