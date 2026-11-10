package kr.eunwol.telemetry;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;

public class EunwolTelemetryClient implements ClientModInitializer {

    @Override
    public void onInitializeClient() {
        Telemetry.init();

        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> Telemetry.onJoin(client));
        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> Telemetry.onDisconnect());
        ClientTickEvents.END_CLIENT_TICK.register(Telemetry::onTick);
    }
}
