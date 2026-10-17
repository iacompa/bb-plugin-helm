package com.example.ledger

import app.cash.turbine.test
import com.example.ledger.data.SaveResult
import com.example.ledger.data.Transaction
import com.example.ledger.data.TransactionRepository
import com.example.ledger.remote.RatesApi
import com.example.ledger.remote.RatesResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TransactionRepositoryTest {
    private val sample = Transaction(description = "Coffee", amountMinor = 320, currency = "EUR", bookedAtEpochDay = 20_000)

    private class StubRates(private val fail: Boolean) : RatesApi {
        override suspend fun latest(base: String): RatesResponse =
            if (fail) error("offline") else RatesResponse(base, mapOf("USD" to 1.1))
    }

    @Test
    fun addEmitsTheNewRow() = runTest {
        val repo = TransactionRepository(FakeTransactionDao(), StubRates(fail = false))
        repo.observe().test {
            assertEquals(emptyList<Transaction>(), awaitItem())
            repo.add(sample)
            assertEquals("Coffee", awaitItem().single().description)
        }
    }

    @Test
    fun failedInsertIsReportedNotSwallowed() = runTest {
        val repo = TransactionRepository(FakeTransactionDao(failInserts = true), StubRates(fail = false))
        assertTrue(repo.add(sample) is SaveResult.Failed)
    }

    // TODO: once rates are cached, assert the stale banner flag instead
    @Test
    fun ratesOutageYieldsNullNotAFakeRate() = runTest {
        val repo = TransactionRepository(FakeTransactionDao(), StubRates(fail = true))
        assertNull(repo.latestRate("EUR", "USD"))
    }
}
