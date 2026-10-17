package com.example.ledger.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.ledger.data.SaveResult
import com.example.ledger.data.Transaction
import com.example.ledger.data.TransactionRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@HiltViewModel
class TransactionListViewModel @Inject constructor(
    private val repository: TransactionRepository,
) : ViewModel() {
    val transactions: StateFlow<List<Transaction>> =
        repository.observe().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _saveError = MutableStateFlow(false)
    val saveError: StateFlow<Boolean> = _saveError.asStateFlow()

    private val _selected = MutableStateFlow<Transaction?>(null)
    val selected: StateFlow<Transaction?> = _selected.asStateFlow()

    fun select(transaction: Transaction) {
        _selected.value = transaction
    }

    fun add(transaction: Transaction) {
        viewModelScope.launch {
            _saveError.value = repository.add(transaction) is SaveResult.Failed
        }
    }
}
