use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{Display, Formatter};

use engineo_project_model::{Activity, ActivityId, Relationship};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GraphError {
    DuplicateActivityId(ActivityId),
    MissingPredecessor(ActivityId),
    MissingSuccessor(ActivityId),
    SelfRelationship(ActivityId),
    Cycle { path: Vec<ActivityId> },
}

impl Display for GraphError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateActivityId(id) => write!(formatter, "duplicate activity ID: {id}"),
            Self::MissingPredecessor(id) => write!(formatter, "unknown predecessor activity: {id}"),
            Self::MissingSuccessor(id) => write!(formatter, "unknown successor activity: {id}"),
            Self::SelfRelationship(id) => {
                write!(formatter, "activity cannot depend on itself: {id}")
            }
            Self::Cycle { path } => write!(formatter, "dependency cycle: {}", path.join(" -> ")),
        }
    }
}

impl Error for GraphError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenEnds {
    pub no_predecessors: Vec<ActivityId>,
    pub no_successors: Vec<ActivityId>,
}

#[derive(Debug, Clone)]
pub struct ScheduleGraph {
    activity_ids: Vec<ActivityId>,
    index_by_id: BTreeMap<ActivityId, usize>,
    successors: Vec<Vec<usize>>,
    predecessors: Vec<Vec<usize>>,
    topological_order: Vec<usize>,
}

impl ScheduleGraph {
    pub fn build(
        activities: &[Activity],
        relationships: &[Relationship],
    ) -> Result<Self, GraphError> {
        let mut activity_ids = activities
            .iter()
            .map(|activity| activity.id.clone())
            .collect::<Vec<_>>();
        activity_ids.sort();

        for pair in activity_ids.windows(2) {
            if pair[0] == pair[1] {
                return Err(GraphError::DuplicateActivityId(pair[0].clone()));
            }
        }

        let index_by_id = activity_ids
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, id)| (id, index))
            .collect::<BTreeMap<_, _>>();

        let mut edges = BTreeSet::new();
        for relationship in relationships {
            if relationship.predecessor_id == relationship.successor_id {
                return Err(GraphError::SelfRelationship(
                    relationship.predecessor_id.clone(),
                ));
            }

            let predecessor = index_by_id
                .get(&relationship.predecessor_id)
                .copied()
                .ok_or_else(|| {
                    GraphError::MissingPredecessor(relationship.predecessor_id.clone())
                })?;
            let successor = index_by_id
                .get(&relationship.successor_id)
                .copied()
                .ok_or_else(|| {
                    GraphError::MissingSuccessor(relationship.successor_id.clone())
                })?;

            edges.insert((predecessor, successor));
        }

        let mut successors = vec![Vec::new(); activity_ids.len()];
        let mut predecessors = vec![Vec::new(); activity_ids.len()];

        for (predecessor, successor) in edges {
            successors[predecessor].push(successor);
            predecessors[successor].push(predecessor);
        }

        let topological_order = topological_sort(&successors, &predecessors);
        if topological_order.len() != activity_ids.len() {
            let cycle = find_cycle(&successors)
                .into_iter()
                .map(|index| activity_ids[index].clone())
                .collect();
            return Err(GraphError::Cycle { path: cycle });
        }

        Ok(Self {
            activity_ids,
            index_by_id,
            successors,
            predecessors,
            topological_order,
        })
    }

    #[must_use]
    pub fn activity_count(&self) -> usize {
        self.activity_ids.len()
    }

    #[must_use]
    pub fn topological_activity_ids(&self) -> Vec<&str> {
        self.topological_order
            .iter()
            .map(|index| self.activity_ids[*index].as_str())
            .collect()
    }

    #[must_use]
    pub fn successors_of(&self, activity_id: &str) -> Option<Vec<&str>> {
        let index = *self.index_by_id.get(activity_id)?;
        Some(
            self.successors[index]
                .iter()
                .map(|successor| self.activity_ids[*successor].as_str())
                .collect(),
        )
    }

    #[must_use]
    pub fn predecessors_of(&self, activity_id: &str) -> Option<Vec<&str>> {
        let index = *self.index_by_id.get(activity_id)?;
        Some(
            self.predecessors[index]
                .iter()
                .map(|predecessor| self.activity_ids[*predecessor].as_str())
                .collect(),
        )
    }

    #[must_use]
    pub fn open_ends(&self) -> OpenEnds {
        let no_predecessors = self
            .predecessors
            .iter()
            .enumerate()
            .filter(|(_, predecessors)| predecessors.is_empty())
            .map(|(index, _)| self.activity_ids[index].clone())
            .collect();

        let no_successors = self
            .successors
            .iter()
            .enumerate()
            .filter(|(_, successors)| successors.is_empty())
            .map(|(index, _)| self.activity_ids[index].clone())
            .collect();

        OpenEnds {
            no_predecessors,
            no_successors,
        }
    }
}

fn topological_sort(successors: &[Vec<usize>], predecessors: &[Vec<usize>]) -> Vec<usize> {
    let mut indegree = predecessors.iter().map(Vec::len).collect::<Vec<_>>();
    let mut ready = indegree
        .iter()
        .enumerate()
        .filter(|(_, degree)| **degree == 0)
        .map(|(index, _)| index)
        .collect::<BTreeSet<_>>();
    let mut order = Vec::with_capacity(successors.len());

    while let Some(node) = ready.pop_first() {
        order.push(node);

        for successor in &successors[node] {
            indegree[*successor] -= 1;
            if indegree[*successor] == 0 {
                ready.insert(*successor);
            }
        }
    }

    order
}

fn find_cycle(successors: &[Vec<usize>]) -> Vec<usize> {
    let mut state = vec![0_u8; successors.len()];
    let mut position = vec![None; successors.len()];

    for start in 0..successors.len() {
        if state[start] != 0 {
            continue;
        }

        let mut path = vec![start];
        let mut stack = vec![(start, 0_usize)];
        state[start] = 1;
        position[start] = Some(0);

        while let Some((node, next_index)) = stack.last_mut() {
            if *next_index >= successors[*node].len() {
                state[*node] = 2;
                position[*node] = None;
                stack.pop();
                path.pop();
                continue;
            }

            let successor = successors[*node][*next_index];
            *next_index += 1;

            match state[successor] {
                0 => {
                    state[successor] = 1;
                    position[successor] = Some(path.len());
                    path.push(successor);
                    stack.push((successor, 0));
                }
                1 => {
                    let cycle_start =
                        position[successor].expect("active DFS node must have a path position");
                    let mut cycle = path[cycle_start..].to_vec();
                    cycle.push(successor);
                    return cycle;
                }
                _ => {}
            }
        }
    }

    Vec::new()
}
