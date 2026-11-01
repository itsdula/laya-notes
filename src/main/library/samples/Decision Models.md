# Decision models

A decision model returns a typed answer and a probability. Hand it a note and a yes-or-no question, and it answers that question. It does not write a paragraph back.

## When to use one

Use a decision model when the program needs a label, a yes or no, or a score on a rubric. The useful part is the probability: a later step can keep the label, or leave the note alone when the model is unsure.

## How tagging works here

Each tag you create is one yes-or-no question. Laya scores every question in a single pass. This app keeps a tag when the probability that it applies is at least one half.

That threshold is a starting point. A note about a recipe should land on cooking. A note about a train ride should land on travel. A welcome note may land on nothing, and that is a valid answer.

## What stays in ordinary code

Counting, dates, and anything that must be exact belong in normal code. The model is for judgments that a person would make by reading.
