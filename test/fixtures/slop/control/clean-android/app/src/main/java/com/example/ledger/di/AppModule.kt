package com.example.ledger.di

import android.content.Context
import androidx.room.Room
import com.example.ledger.BuildConfig
import com.example.ledger.data.LedgerDatabase
import com.example.ledger.data.TransactionDao
import com.example.ledger.remote.RatesApi
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): LedgerDatabase =
        Room.databaseBuilder(context, LedgerDatabase::class.java, "ledger.db").build()

    @Provides
    fun transactionDao(db: LedgerDatabase): TransactionDao = db.transactions()

    @Provides
    @Singleton
    fun ratesApi(): RatesApi {
        val logging = HttpLoggingInterceptor().apply {
            // Headers only, and only in debug: bodies can contain amounts.
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.HEADERS else HttpLoggingInterceptor.Level.NONE
        }
        val client = OkHttpClient.Builder().addInterceptor(logging).build()
        return Retrofit.Builder()
            .baseUrl(BuildConfig.RATES_BASE_URL)
            .client(client)
            .addConverterFactory(Json { ignoreUnknownKeys = true }.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(RatesApi::class.java)
    }
}
