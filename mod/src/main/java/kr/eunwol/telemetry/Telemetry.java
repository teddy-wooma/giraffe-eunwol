package kr.eunwol.telemetry;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.player.LocalPlayer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Consumer;

/**
 * 은월마을 활동 텔레메트리.
 *
 * 런처가 게임 실행 직전에 config/eunwol-telemetry.json 을 기록하면
 * 이 모드가 세션 시작/하트비트/종료를 백엔드로 전송합니다.
 */
public final class Telemetry {

    private static final Logger LOG = LoggerFactory.getLogger("eunwol-telemetry");
    private static final Gson GSON = new Gson();
    private static final String CONFIG_FILE = "eunwol-telemetry.json";
    private static final long HEARTBEAT_INTERVAL_MS = 60_000L;

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    private static volatile Config config;

    private static volatile String sessionId;
    private static volatile String dimension = "unknown";
    private static volatile long joinedAt;
    private static volatile long lastActivity;
    private static volatile long lastHeartbeat;
    private static volatile double lastX;
    private static volatile double lastY;
    private static volatile double lastZ;
    private static volatile float lastYaw;
    private static volatile float lastPitch;

    private Telemetry() {
    }

    static void init() {
        config = loadConfig();
        if (config == null || !config.enabled()) {
            LOG.info("Eunwol telemetry disabled (no config)");
        } else {
            LOG.info("Eunwol telemetry ready: {}", config.backendUrl());
        }
    }

    // ------------------------------------------------------------------
    // 이벤트
    // ------------------------------------------------------------------

    static void onJoin(Minecraft client) {
        config = loadConfig();
        if (!enabled()) {
            return;
        }

        ServerData server = client.getCurrentServer();
        if (server == null) {
            return; // 싱글플레이
        }

        LocalPlayer player = client.player;
        joinedAt = System.currentTimeMillis();
        lastActivity = joinedAt;
        lastHeartbeat = joinedAt;
        dimension = resolveDimension(client);

        if (player != null) {
            lastX = player.getX();
            lastY = player.getY();
            lastZ = player.getZ();
            lastYaw = player.getYRot();
            lastPitch = player.getXRot();
        }

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("serverAddress", server.ip);
        body.put("dimension", dimension);

        post("/v1/mod/session/start", body, response -> {
            if (response != null && response.has("sessionId")) {
                sessionId = response.get("sessionId").getAsString();
                LOG.info("Eunwol telemetry session started: {}", sessionId);
            }
        });
    }

    static void onDisconnect() {
        if (sessionId == null) {
            return;
        }
        String id = sessionId;
        sessionId = null;

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", id);
        body.put("playSeconds", playSeconds());
        body.put("afkSeconds", afkSeconds());
        post("/v1/mod/session/end", body, null);
        LOG.info("Eunwol telemetry session ended: {}", id);
    }

    static void onTick(Minecraft client) {
        if (sessionId == null || !enabled()) {
            return;
        }

        LocalPlayer player = client.player;
        if (player != null) {
            dimension = resolveDimension(client);

            double dx = player.getX() - lastX;
            double dy = player.getY() - lastY;
            double dz = player.getZ() - lastZ;
            float dyaw = Math.abs(player.getYRot() - lastYaw);
            float dpitch = Math.abs(player.getXRot() - lastPitch);

            if (dx * dx + dy * dy + dz * dz > 0.0001D || dyaw > 0.5F || dpitch > 0.5F) {
                lastActivity = System.currentTimeMillis();
            }

            lastX = player.getX();
            lastY = player.getY();
            lastZ = player.getZ();
            lastYaw = player.getYRot();
            lastPitch = player.getXRot();

            long now = System.currentTimeMillis();
            if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
                lastHeartbeat = now;
                sendHeartbeat(player);
            }
        }
    }

    private static void sendHeartbeat(LocalPlayer player) {
        Map<String, Object> position = new LinkedHashMap<>();
        position.put("x", Math.round(player.getX() * 100.0D) / 100.0D);
        position.put("y", Math.round(player.getY() * 100.0D) / 100.0D);
        position.put("z", Math.round(player.getZ() * 100.0D) / 100.0D);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessionId", sessionId);
        body.put("dimension", dimension);
        body.put("position", position);
        body.put("afkSeconds", afkSeconds());
        body.put("playSeconds", playSeconds());
        post("/v1/mod/heartbeat", body, null);
    }

    // ------------------------------------------------------------------
    // 유틸
    // ------------------------------------------------------------------

    private static boolean enabled() {
        return config != null && config.enabled() && config.token() != null && !config.token().isBlank();
    }

    private static long playSeconds() {
        if (joinedAt == 0L) {
            return 0L;
        }
        return Math.max(0L, (System.currentTimeMillis() - joinedAt) / 1000L);
    }

    private static long afkSeconds() {
        if (lastActivity == 0L) {
            return 0L;
        }
        long idle = Math.max(0L, (System.currentTimeMillis() - lastActivity) / 1000L);
        return Math.min(idle, playSeconds());
    }

    private static String resolveDimension(Minecraft client) {
        if (client.level == null) {
            return dimension;
        }
        return client.level.dimension().identifier().toString();
    }

    private static void post(String path, Map<String, Object> body, Consumer<JsonObject> onSuccess) {
        Config current = config;
        if (current == null || current.token() == null) {
            return;
        }

        String json = GSON.toJson(body);
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(current.backendUrl() + path))
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + current.token())
                    .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8))
                    .build();

            HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8))
                    .thenAccept(response -> {
                        int status = response.statusCode();
                        if (status >= 200 && status < 300) {
                            if (onSuccess != null) {
                                try {
                                    onSuccess.accept(GSON.fromJson(response.body(), JsonObject.class));
                                } catch (Exception ignored) {
                                }
                            }
                        } else if (status != 401) {
                            LOG.warn("telemetry {} -> HTTP {}", path, status);
                        }
                    })
                    .exceptionally(err -> {
                        LOG.debug("telemetry {} failed: {}", path, err.getMessage());
                        return null;
                    });
        } catch (Exception err) {
            LOG.debug("telemetry request error: {}", err.getMessage());
        }
    }

    private static Config loadConfig() {
        try {
            Path path = FabricLoader.getInstance().getConfigDir().resolve(CONFIG_FILE);
            if (!Files.exists(path)) {
                return null;
            }
            String raw = Files.readString(path, StandardCharsets.UTF_8);
            Config parsed = GSON.fromJson(raw, Config.class);
            if (parsed == null) {
                return null;
            }
            return parsed.normalized();
        } catch (Exception err) {
            LOG.warn("telemetry config read failed: {}", err.getMessage());
            return null;
        }
    }

    record Config(String backendUrl, String token, boolean enabled) {
        Config normalized() {
            String url = backendUrl == null || backendUrl.isBlank()
                    ? "https://eunwol.duckdns.org"
                    : backendUrl.replaceAll("/+$", "");
            return new Config(url, token, enabled);
        }
    }
}
