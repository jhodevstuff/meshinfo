<?php
$apiKey = 'api-key';
$baseDir = __DIR__;
$nodesIndexPath = "$baseDir/nodesindex.json";
$combinedDataPath = "$baseDir/meshdata_combined.json";

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $jsonData = file_get_contents("php://input");
  if ($jsonData) {
    $data = json_decode($jsonData, true);
    if (json_last_error() === JSON_ERROR_NONE) {
      if (!isset($data['apiKey']) || $data['apiKey'] !== $apiKey) {
        http_response_code(403);
        echo json_encode(['status' => 'error', 'message' => 'Falscher API key']);
        exit;
      }
      unset($data['apiKey']);
      $nodeId = $data['info']['infoFrom'] ?? null;
      if (!$nodeId) {
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'Keine nodeId gefunden']);
        exit;
      }
      $filePath = "$baseDir/meshdata_" . preg_replace("/[^a-zA-Z0-9_!]/", "_", $nodeId) . ".json";
      if (file_put_contents($filePath, json_encode($data, JSON_PRETTY_PRINT))) {
        updateNodesIndex($nodeId, $nodesIndexPath);
        updateCombinedData($data, $combinedDataPath, $baseDir);
        http_response_code(200);
        echo json_encode(['status' => 'success', 'message' => 'Erfolgreich gespeichert']);
      } else {
        http_response_code(500);
        echo json_encode(['status' => 'error', 'message' => 'Fehler beim Speichern']);
      }
    } else {
      http_response_code(400);
      echo json_encode(['status' => 'error', 'message' => 'JSON Fehler']);
    }
  } else {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'Keine Daten']);
  }
} else {
  http_response_code(405);
  echo json_encode(['status' => 'error', 'message' => 'Fuck off']);
}

function updateNodesIndex($nodeId, $nodesIndexPath) {
  $nodes = [];
  if (file_exists($nodesIndexPath)) {
    $indexData = file_get_contents($nodesIndexPath);
    $nodes = json_decode($indexData, true) ?? [];
  }
  if (!in_array($nodeId, $nodes)) {
    $nodes[] = $nodeId;
    file_put_contents($nodesIndexPath, json_encode($nodes, JSON_PRETTY_PRINT));
  }
}

function updateCombinedData($newData, $combinedDataPath, $baseDir) {
  $lockFile = $combinedDataPath . '.lock';
  $lockHandle = fopen($lockFile, 'w');
  if (!flock($lockHandle, LOCK_EX)) {
    fclose($lockHandle);
    return false;
  }
  
  try {
    $combinedData = [];
    if (file_exists($combinedDataPath)) {
      $existingData = file_get_contents($combinedDataPath);
      $combinedData = json_decode($existingData, true) ?? [];
    }
    if (isset($newData['knownNodes']) && is_array($newData['knownNodes'])) {
      foreach ($newData['knownNodes'] as $node) {
        if (!isset($node['id'])) continue;
        $nodeId = $node['id'];
        $existingNode = $combinedData[$nodeId] ?? null;
        $updatedNode = mergeNodeData($existingNode, $node);
        if ($updatedNode) {
          $combinedData[$nodeId] = $updatedNode;
        }
      }
    }
    file_put_contents($combinedDataPath, json_encode($combinedData, JSON_PRETTY_PRINT));
  } finally {
    flock($lockHandle, LOCK_UN);
    fclose($lockHandle);
    @unlink($lockFile);
  }
  return true;
}

function mergeNodeData($existingNode, $newNode) {
  if (!$existingNode) {
    return createCompactNode($newNode);
  }
  $mergedNode = $existingNode;
  $mergedNode['longName'] = $newNode['longName'] ?? $mergedNode['longName'];
  $mergedNode['shortName'] = $newNode['shortName'] ?? $mergedNode['shortName'];
  $mergedNode['model'] = $newNode['model'] ?? $mergedNode['model'];
  $mergedNode['publicKey'] = $newNode['publicKey'] ?? $mergedNode['publicKey'];
  if (isset($newNode['lat']) && $newNode['lat'] !== null) {
    $mergedNode['lat'] = $newNode['lat'];
  }
  if (isset($newNode['lon']) && $newNode['lon'] !== null) {
    $mergedNode['lon'] = $newNode['lon'];
  }
  $existingLastHeard = $mergedNode['lastHeard'] ?? 0;
  $newLastHeard = $newNode['lastHeard'] ?? 0;
  if ($newLastHeard > $existingLastHeard) {
    $mergedNode['lastHeard'] = $newLastHeard;
  }
  $existingBatteryTime = $mergedNode['batteryLevelTimestamp'] ?? 0;
  $newBatteryTime = getBatteryTimestamp($newNode);
  if (($newBatteryTime > $existingBatteryTime || ($mergedNode['batteryLevel'] === null && isset($newNode['batteryLevel']) && $newNode['batteryLevel'] !== null)) 
      && isset($newNode['batteryLevel']) && $newNode['batteryLevel'] !== null) {
    $mergedNode['batteryLevel'] = $newNode['batteryLevel'];
    $mergedNode['batteryLevelTimestamp'] = $newBatteryTime;
  }
  $existingVoltageTime = $mergedNode['voltageTimestamp'] ?? 0;
  $newVoltageTime = getVoltageTimestamp($newNode);
  if (($newVoltageTime > $existingVoltageTime || ($mergedNode['voltage'] === null && isset($newNode['voltage']) && $newNode['voltage'] !== null)) 
      && isset($newNode['voltage']) && $newNode['voltage'] !== null) {
    $mergedNode['voltage'] = $newNode['voltage'];
    $mergedNode['voltageTimestamp'] = $newVoltageTime;
  }
  if (isset($newNode['uptimeSeconds']) && $newNode['uptimeSeconds'] !== null) {
    $mergedNode['uptimeSeconds'] = $newNode['uptimeSeconds'];
  }
  $existingLastOnline = $mergedNode['lastOnline'] ?? 0;
  $newLastOnline = getLastOnlineTimestamp($newNode);
  if ($newLastOnline > $existingLastOnline) {
    $mergedNode['lastOnline'] = $newLastOnline;
  }
  return $mergedNode;
}

function createCompactNode($node) {
  $compactNode = [
    'longName' => $node['longName'] ?? null,
    'shortName' => $node['shortName'] ?? null,
    'model' => $node['model'] ?? null,
    'lastHeard' => $node['lastHeard'] ?? null,
    'batteryLevel' => (isset($node['batteryLevel']) && $node['batteryLevel'] !== null) ? $node['batteryLevel'] : null,
    'batteryLevelTimestamp' => getBatteryTimestamp($node),
    'voltage' => (isset($node['voltage']) && $node['voltage'] !== null) ? $node['voltage'] : null,
    'voltageTimestamp' => getVoltageTimestamp($node),
    'uptimeSeconds' => $node['uptimeSeconds'] ?? null,
    'lat' => $node['lat'] ?? null,
    'lon' => $node['lon'] ?? null,
    'publicKey' => $node['publicKey'] ?? null,
    'lastOnline' => getLastOnlineTimestamp($node)
  ];
  return $compactNode;
}

function getBatteryTimestamp($node) {
  if (isset($node['power']['batteryLevel']) && is_array($node['power']['batteryLevel'])) {
    $timestamps = array_column($node['power']['batteryLevel'], 'timestamp');
    if (!empty($timestamps)) {
      return max($timestamps);
    }
  }
  return $node['lastHeard'] ?? 0;
}

function getVoltageTimestamp($node) {
  if (isset($node['power']['voltage']) && is_array($node['power']['voltage'])) {
    $timestamps = array_column($node['power']['voltage'], 'timestamp');
    if (!empty($timestamps)) {
      return max($timestamps);
    }
  }
  return $node['lastHeard'] ?? 0;
}

function getLastOnlineTimestamp($node) {
  if (isset($node['online']) && is_array($node['online']) && !empty($node['online'])) {
    return max($node['online']);
  }
  return $node['lastHeard'] ?? 0;
}
