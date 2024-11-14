<?php
$apiKey = 'api-key';
$baseDir = __DIR__;
$nodesIndexPath = "$baseDir/nodesindex.json";

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
