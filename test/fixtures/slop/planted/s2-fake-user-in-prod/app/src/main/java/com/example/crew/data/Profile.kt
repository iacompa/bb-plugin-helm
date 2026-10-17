package com.example.crew.data

data class Profile(
    val name: String,
    val email: String,
    val teammates: List<String>,
    val streakDays: Int,
)

interface ProfileRepository {
    fun current(): Profile
}
