<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET');
header('Access-Control-Allow-Headers: Content-Type');
$baseDir = __DIR__;
$combinedDataPath = "$baseDir/meshdata_combined.json";
$nodeId = $_GET['nodeId'] ?? $_GET['nodeid'] ?? $_GET['id'] ?? null;
if (!$nodeId) {
    http_response_code(400);
    echo json_encode([
        'status' => 'error', 
        'message' => 'Parameter nodeId fehlt',
        'usage' => 'getNodeInfo.php?nodeId=NODEID'
    ]);
    exit;
}
if (!file_exists($combinedDataPath)) {
    http_response_code(404);
    echo json_encode([
        'status' => 'error', 
        'message' => 'Mesh-Daten nicht gefunden'
    ]);
    exit;
}
$combinedData = file_get_contents($combinedDataPath);
$nodes = json_decode($combinedData, true);
if (json_last_error() !== JSON_ERROR_NONE) {
    http_response_code(500);
    echo json_encode([
        'status' => 'error', 
        'message' => 'Fehler beim Laden der Mesh-Daten'
    ]);
    exit;
}
$searchNodeId = $nodeId;
if (!str_starts_with($nodeId, '!')) {
    $searchNodeId = '!' . $nodeId;
}
$altNodeId = str_starts_with($nodeId, '!') ? substr($nodeId, 1) : $nodeId;
$foundNode = null;
$foundNodeId = null;
if (isset($nodes[$searchNodeId])) {
    $foundNode = $nodes[$searchNodeId];
    $foundNodeId = $searchNodeId;
}
elseif (isset($nodes[$altNodeId])) {
    $foundNode = $nodes[$altNodeId];
    $foundNodeId = $altNodeId;
}
if (!$foundNode) {
    http_response_code(404);
    echo json_encode([
        'status' => 'error', 
        'message' => 'Node nicht gefunden'
    ]);
    exit;
}
http_response_code(200);
echo json_encode($foundNode, JSON_PRETTY_PRINT);
?>
