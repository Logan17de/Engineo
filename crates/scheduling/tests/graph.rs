use engineo_project_model::{Activity, ActivityKind, Relationship, RelationshipType};
use engineo_scheduling::{GraphError, ScheduleGraph};

fn activity(id: &str) -> Activity {
    Activity {
        id: id.to_owned(),
        wbs_id: "wbs-root".to_owned(),
        name: id.to_owned(),
        kind: ActivityKind::Task,
        duration_minutes: 480,
        calendar_id: "standard".to_owned(),
        constraints: Vec::new(),
    }
}

fn relationship(predecessor: &str, successor: &str) -> Relationship {
    Relationship {
        predecessor_id: predecessor.to_owned(),
        successor_id: successor.to_owned(),
        relationship_type: RelationshipType::FinishToStart,
        lag_minutes: 0,
    }
}

#[test]
fn topological_order_is_stable_regardless_of_input_order() {
    let activities = vec![activity("C"), activity("A"), activity("B")];
    let relationships = vec![relationship("B", "C"), relationship("A", "C")];

    let graph = ScheduleGraph::build(&activities, &relationships).expect("graph is valid");

    assert_eq!(graph.topological_activity_ids(), vec!["A", "B", "C"]);
    assert_eq!(graph.predecessors_of("C"), Some(vec!["A", "B"]));
    assert_eq!(graph.successors_of("A"), Some(vec!["C"]));
}

#[test]
fn graph_deduplicates_parallel_topology_edges() {
    let activities = vec![activity("A"), activity("B")];
    let mut second = relationship("A", "B");
    second.relationship_type = RelationshipType::StartToStart;
    let relationships = vec![relationship("A", "B"), second];

    let graph = ScheduleGraph::build(&activities, &relationships).expect("graph is valid");

    assert_eq!(graph.topological_activity_ids(), vec!["A", "B"]);
    assert_eq!(graph.successors_of("A"), Some(vec!["B"]));
}

#[test]
fn cycle_error_contains_actionable_closed_path() {
    let activities = vec![activity("C"), activity("B"), activity("A")];
    let relationships = vec![
        relationship("A", "B"),
        relationship("B", "C"),
        relationship("C", "A"),
    ];

    let error = ScheduleGraph::build(&activities, &relationships).expect_err("cycle must fail");

    assert_eq!(
        error,
        GraphError::Cycle {
            path: vec![
                "A".to_owned(),
                "B".to_owned(),
                "C".to_owned(),
                "A".to_owned(),
            ],
        }
    );
}

#[test]
fn missing_and_self_relationships_fail_explicitly() {
    let activities = vec![activity("A"), activity("B")];

    assert_eq!(
        ScheduleGraph::build(&activities, &[relationship("missing", "B")])
            .expect_err("missing predecessor must fail"),
        GraphError::MissingPredecessor("missing".to_owned())
    );
    assert_eq!(
        ScheduleGraph::build(&activities, &[relationship("A", "missing")])
            .expect_err("missing successor must fail"),
        GraphError::MissingSuccessor("missing".to_owned())
    );
    assert_eq!(
        ScheduleGraph::build(&activities, &[relationship("A", "A")])
            .expect_err("self relationship must fail"),
        GraphError::SelfRelationship("A".to_owned())
    );
}

#[test]
fn duplicate_activity_ids_fail_before_graph_construction() {
    let activities = vec![activity("A"), activity("A")];

    assert_eq!(
        ScheduleGraph::build(&activities, &[]).expect_err("duplicate ID must fail"),
        GraphError::DuplicateActivityId("A".to_owned())
    );
}

#[test]
fn open_end_diagnostics_include_isolated_activities() {
    let activities = vec![activity("A"), activity("B"), activity("C")];
    let graph =
        ScheduleGraph::build(&activities, &[relationship("A", "B")]).expect("graph is valid");

    let open_ends = graph.open_ends();

    assert_eq!(
        open_ends.no_predecessors,
        vec!["A".to_owned(), "C".to_owned()]
    );
    assert_eq!(
        open_ends.no_successors,
        vec!["B".to_owned(), "C".to_owned()]
    );
}

#[test]
fn ten_thousand_activity_chain_builds_without_recursion() {
    const ACTIVITY_COUNT: usize = 10_000;

    let activities = (0..ACTIVITY_COUNT)
        .map(|index| activity(&format!("A{index:05}")))
        .collect::<Vec<_>>();
    let relationships = (0..ACTIVITY_COUNT - 1)
        .map(|index| relationship(&format!("A{index:05}"), &format!("A{:05}", index + 1)))
        .collect::<Vec<_>>();

    let graph = ScheduleGraph::build(&activities, &relationships).expect("large DAG is valid");

    assert_eq!(graph.activity_count(), ACTIVITY_COUNT);
    assert_eq!(
        graph.topological_activity_ids().first().copied(),
        Some("A00000")
    );
    assert_eq!(
        graph.topological_activity_ids().last().copied(),
        Some("A09999")
    );
}
