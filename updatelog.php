<?php
$filePath = __DIR__ . '/meshdata.json';
$apiKey = 'api-key';

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
      $jsonData = json_encode($data);
      if (file_put_contents($filePath, $jsonData)) {
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
