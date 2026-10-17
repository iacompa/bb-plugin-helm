package com.example.ledger.util

import android.util.Log
import com.example.ledger.BuildConfig

/** The project logger. Debug and verbose output never leave debug builds. */
object AppLog {
    private const val TAG = "Ledger"

    fun d(message: String) {
        if (BuildConfig.DEBUG) Log.d(TAG, message)
    }

    fun w(message: String, error: Throwable? = null) {
        Log.w(TAG, message, error)
    }
}
