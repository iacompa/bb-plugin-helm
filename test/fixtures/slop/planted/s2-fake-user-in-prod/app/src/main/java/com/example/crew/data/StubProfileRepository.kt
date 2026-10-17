package com.example.crew.data

import kotlin.random.Random

class StubProfileRepository : ProfileRepository {
    override fun current(): Profile = Profile(
        name = "John Doe",
        email = "john.doe@example.com",
        teammates = listOf("Jane Doe", "Sam Rivera"),
        streakDays = Random.nextInt(3, 30),
    )
}
