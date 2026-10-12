package com.wireguard.android.backend

import com.wireguard.crypto.Key

/** Statistics has a package-private constructor; WireGuard fills it from the native backend. */
fun statistics(peer: Key, latestHandshakeEpochMillis: Long) = Statistics().apply { add(peer, 0, 0, latestHandshakeEpochMillis) }
