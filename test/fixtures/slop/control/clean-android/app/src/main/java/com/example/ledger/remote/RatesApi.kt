package com.example.ledger.remote

import kotlinx.serialization.Serializable
import retrofit2.http.GET
import retrofit2.http.Query

@Serializable
data class RatesResponse(val base: String, val rates: Map<String, Double>)

interface RatesApi {
    @GET("latest")
    suspend fun latest(@Query("base") base: String): RatesResponse
}
